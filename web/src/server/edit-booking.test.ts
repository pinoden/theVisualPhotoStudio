import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookingAddons, bookingEvents, bookings, promoCodes, studioHolds } from "@/db/schema";
import { createManualCode, saveAddon } from "./admin";
import type { AuthUser } from "./auth";
import { loadCatalog } from "./catalog";
import { formatCents } from "@/lib/domain/pricing";
import { getAppointment, moveBooking } from "./appointments";
import { editBooking } from "./edit-booking";
import { BASE_URL, createTestWorld, expectOk, FAR, h, NOW, OWNER_EMAIL, type TestWorld } from "./testing";

/**
 * A booking's studios, length, guests and add-ons changed by an owner (the owner's admin brief of 2026-11-22, item 5;
 * the owner's answer of 2026-11-23: "Editing price is for owner only"; question 75 in ProjectLibrary.md).
 */
let world: TestWorld;
let owner: AuthUser;
let manager: AuthUser;

beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser("owner@studio.test", "owner", "Olivia");
  manager = await world.addUser("manager@studio.test", "manager", "Mona");
});

const bob = { name: "Bob Brown", email: "bob@example.com", phone: "407-555-0101" };
const rowOf = async (ref: string) => (await world.db.select().from(bookings).where(eq(bookings.ref, ref)))[0];
const heldBy = async (id: string) => (await world.db.select({ studioId: studioHolds.studioId, priceCents: studioHolds.priceCents }).from(studioHolds).where(eq(studioHolds.bookingId, id))).map((hold) => hold.studioId).sort();
const addonId = async (slug: string) => (await loadCatalog(world.db)).addons.find((addon) => addon.name === slug)!.id;

describe("an owner changes a booking", () => {
  it("to two studios and an add-on: priced again, its holds and add-ons changed, the client told what is still to pay", async () => {
    const booked = expectOk(await world.book({ date: FAR, studioIds: [world.ids.paris], durationMinutes: 60 }));
    const before = await rowOf(booked.ref);
    const pet = await addonId("Pet fee"); // Dayglow's

    const changed = await editBooking(world.db, owner, booked.ref, { studioIds: [world.ids.paris, world.ids.dayglow], durationMinutes: 120, addons: [{ addonId: pet, quantity: 1 }] }, NOW);
    expect(changed).toMatchObject({ ok: true, wasCents: before.totalCents, creditLeftCents: 0 });
    const after = await rowOf(booked.ref);
    if (!changed.ok) throw new Error("not changed");
    expect(changed.nowCents).toBe(after.totalCents);
    expect(changed.owedCents).toBe(after.totalCents - before.totalCents); // paid by card before: the rest is owed
    expect(after).toMatchObject({ durationMinutes: 120, endAt: new Date(before.startAt.getTime() + 120 * 60_000), addonsCents: 4000 });
    expect(after).toMatchObject({ studiosSubtotalCents: 23000, multiStudioDiscountCents: 0 }); // the bundle's own price for two hours
    expect(await heldBy(before.id)).toEqual([world.ids.dayglow, world.ids.paris].sort());
    expect(await world.db.select({ name: bookingAddons.name, quantity: bookingAddons.quantity, unitCents: bookingAddons.unitCents }).from(bookingAddons).where(eq(bookingAddons.bookingId, before.id))).toEqual([{ name: "Pet fee", quantity: 1, unitCents: 4000 }]);

    const [event] = await world.db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, before.id)).orderBy(bookingEvents.at);
    const events = await world.db.select({ note: bookingEvents.note, actor: bookingEvents.actor }).from(bookingEvents).where(eq(bookingEvents.bookingId, before.id));
    expect(event).toBeDefined();
    expect(events.at(-1)).toMatchObject({ actor: "owner@studio.test", note: expect.stringMatching(/^Changed from Studio Paris, 1 hour to Studio Dayglow \+ Studio Paris, 2 hours, Pet fee: \$[\d.,]+ instead of \$[\d.,]+$/) });
    const mail = (await world.emails("booking_changed")).at(-1)!;
    expect(mail.toEmail).toBe("jane@example.com");
    expect(mail.subject).toBe(`Your booking ${booked.ref} has changed`);
    expect(mail.body).toContain("Add-ons and extra guests: Pet fee");
    expect(mail.body).toContain("It was: Studio Paris, 1 hour");
    expect(mail.body).toMatch(/Its total is now \$[\d.,]+ instead of \$[\d.,]+\.\nStill to pay: \$[\d.,]+, at the studio or with a payment link we email you\./);

    // And back to less than was paid: the difference is the client's, to refund.
    const shorter = await editBooking(world.db, owner, booked.ref, { studioIds: [world.ids.paris], durationMinutes: 60, addons: [] }, NOW);
    expect(shorter).toMatchObject({ ok: true, owedCents: 0, creditLeftCents: 0 }); // what was paid, again
    // A booking of two hours made one: paid for two, the difference is the client's, to refund.
    const longer = expectOk(await world.book({ date: FAR, studioIds: [world.ids.blanche], startMinute: h(14), durationMinutes: 120, customer: bob }));
    const paid = (await rowOf(longer.ref)).totalCents;
    expect(await world.emails("owner_refund_owed")).toHaveLength(0);
    const halved = await editBooking(world.db, owner, longer.ref, { studioIds: [world.ids.blanche], durationMinutes: 60, addons: [] }, NOW, { ownerEmail: OWNER_EMAIL, baseUrl: BASE_URL });
    if (!halved.ok) throw new Error(halved.message);
    expect(halved.creditLeftCents).toBe(paid - halved.nowCents);
    expect(halved.creditLeftCents).toBeGreaterThan(0);
    expect((await world.emails("booking_changed")).at(-1)!.body).toContain("more than that: we will refund it to you.");
    // The owners are told of the refund that promises (the owners' decision of 2026-11-27).
    const [notice] = await world.emails("owner_refund_owed");
    expect(notice).toMatchObject({ toEmail: OWNER_EMAIL, subject: `ACTION NEEDED: ${formatCents(halved.creditLeftCents)} to refund for ${longer.ref}` });
    expect(notice.body).toContain(`owner@studio.test changed booking ${longer.ref} from Studio Blanche, 2 hours to Studio Blanche, 1 hour.`);
    expect(notice.body).toContain(`${BASE_URL}/admin/appointments/${longer.ref}`);
  });

  it("can still change a booking that carries the fee for a move, which is no charge of its visit", async () => {
    const booked = expectOk(await world.book({ date: FAR, studioIds: [world.ids.blanche], durationMinutes: 60 }));
    // The client's free move, then one more made for them: $20.
    expectOk(await moveBooking(world.db, owner, booked.ref, { date: FAR, startMinute: h(12), countsAsClientMove: true }, NOW));
    expect(await moveBooking(world.db, owner, booked.ref, { date: FAR, startMinute: h(14), countsAsClientMove: true }, NOW)).toMatchObject({ ok: true, feeCents: 2000 });
    const before = (await rowOf(booked.ref)).totalCents;
    const longer = await editBooking(world.db, owner, booked.ref, { studioIds: [world.ids.blanche], durationMinutes: 120, addons: [] }, NOW);
    if (!longer.ok) throw new Error(longer.message);
    // What it owes is the longer booking's difference and the fee together.
    expect(longer.owedCents).toBe(longer.nowCents - before + 2000);
    expect((await getAppointment(world.db, owner, booked.ref, NOW))!.payments).toMatchObject({ chargesCents: 2000, dueCents: longer.owedCents });
  });

  it("gives back on its code the credit the new price no longer needs", async () => {
    const credit = expectOk(await createManualCode(world.db, { kind: "amount", value: 30000, email: "jane@example.com", validDays: 30, maxUses: 1, note: "" }, NOW));
    const booked = expectOk(await world.book({ date: FAR, studioIds: [world.ids.paris], durationMinutes: 120, promoCode: credit.code, paymentToken: undefined }));
    const before = await rowOf(booked.ref);
    expect(before.totalCents).toBe(0);
    const [left] = await world.db.select({ value: promoCodes.value }).from(promoCodes).where(eq(promoCodes.code, credit.code));
    const changed = await editBooking(world.db, owner, booked.ref, { studioIds: [world.ids.paris], durationMinutes: 60, addons: [] }, NOW);
    if (!changed.ok) throw new Error(changed.message);
    expect(changed.codeBack).toEqual({ code: credit.code, cents: before.creditAppliedCents - (await rowOf(booked.ref)).creditAppliedCents });
    const [now] = await world.db.select({ value: promoCodes.value }).from(promoCodes).where(eq(promoCodes.code, credit.code));
    expect(now.value).toBe(left.value + changed.codeBack!.cents);
    expect((await rowOf(booked.ref)).totalCents).toBe(0); // the credit still pays all of it
  });

  it("refuses anyone but an owner, a time not free, a session, a mix the studios refuse, and no change", async () => {
    const booked = expectOk(await world.book({ date: FAR, studioIds: [world.ids.paris], startMinute: h(10), durationMinutes: 60 }));
    expectOk(await world.book({ date: FAR, studioIds: [world.ids.dayglow], startMinute: h(10) + 30, durationMinutes: 60, customer: bob }));
    expect(await editBooking(world.db, manager, booked.ref, { studioIds: [world.ids.paris], durationMinutes: 120, addons: [] }, NOW)).toEqual({
      ok: false,
      message: "Only an owner can change a booking's studios, length, guests or add-ons: it changes its price.",
    });
    expect(await editBooking(world.db, owner, booked.ref, { studioIds: [world.ids.paris, world.ids.dayglow], durationMinutes: 60, addons: [] }, NOW)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^Studio Dayglow is not free for 1 hour from /),
    });
    expect(await editBooking(world.db, owner, booked.ref, { studioIds: [world.ids.blanche, world.ids.dayglow], durationMinutes: 60, addons: [] }, NOW)).toMatchObject({ ok: false });
    expect(await editBooking(world.db, owner, booked.ref, { studioIds: [world.ids.paris], durationMinutes: 60, addons: [] }, NOW)).toEqual({ ok: false, message: "Nothing was changed." });
    const guest = await addonId("Extra guest");
    expect(await editBooking(world.db, owner, booked.ref, { studioIds: [world.ids.paris], durationMinutes: 60, addons: [{ addonId: guest, quantity: 99 }] }, NOW)).toMatchObject({ ok: false });
    expect(await editBooking(world.db, owner, booked.ref, { studioIds: [world.ids.paris], durationMinutes: 50, addons: [] }, NOW)).toEqual({ ok: false, message: "Choose a length." });
    // Nothing of it changed on the way.
    expect(await heldBy((await rowOf(booked.ref)).id)).toEqual([world.ids.paris]);

    const session = expectOk(await world.book({ photography: true, date: "2026-12-02", durationMinutes: 60 }));
    expect(await editBooking(world.db, owner, session.ref, { studioIds: [world.ids.paris], durationMinutes: 60, addons: [] }, NOW)).toMatchObject({ ok: false, message: expect.stringMatching(/^A session's studio and length/) });
    // Started already: time added is an extra charge.
    expect(await editBooking(world.db, owner, booked.ref, { studioIds: [world.ids.paris], durationMinutes: 120, addons: [] }, new Date(`${FAR}T15:30:00Z`))).toMatchObject({ ok: false, message: expect.stringMatching(/^Only a booking that has not started/) });
  });

  it("keeps the props a booking reserves to what there are", async () => {
    const wings = expectOk(await saveAddon(world.db, null, { name: "Angel wings", description: "", priceCents: 4000, kind: "other", studioId: null, stock: 1 })).id;
    expectOk(await world.book({ date: FAR, studioIds: [world.ids.blanche], startMinute: h(10), durationMinutes: 60, addons: [{ addonId: wings, quantity: 1 }], customer: bob }));
    const booked = expectOk(await world.book({ date: FAR, studioIds: [world.ids.paris], startMinute: h(10), durationMinutes: 60 }));
    expect(await editBooking(world.db, owner, booked.ref, { studioIds: [world.ids.paris], durationMinutes: 60, addons: [{ addonId: wings, quantity: 1 }] }, NOW)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^Angel wings/),
    });
  });
});
