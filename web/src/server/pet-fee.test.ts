import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { addons, bookingAddons, bookings, promoCodes, refunds } from "@/db/schema";
import { getAppointment } from "./appointments";
import type { AuthUser } from "./auth";
import { listBookings } from "./admin";
import { cancelBooking, getManageChoices, ownerCancelBooking, ownerRefund, requestRescheduleCode } from "./manage";
import { givePetFeeCredit, petFeeCentsOf } from "./pet-fee";
import { BASE_URL, createTestWorld, daysAfter, expectOk, FAR, h, NEAR, NOW, type TestWorld } from "./testing";

/**
 * The owner's rule of 2026-11-15: the pet fee ($40, Studio Dayglow) is not
 * refunded, and if the pet is not brought it becomes studio credit.
 */
let world: TestWorld;
let owner: AuthUser;
let sam: AuthUser; // staff
let petFeeId: string;

beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser("owner@studio.test", "owner", "Olivia");
  sam = await world.addUser("sam@studio.test", "staff", "Sam");
  petFeeId = (await world.db.select().from(addons).where(eq(addons.slug, "pet-fee")))[0].id;
});

const byToken = (token: string) => ({ kind: "token", token }) as const;
const deps = () => ({ now: NOW, baseUrl: BASE_URL });
const codes = () => world.db.select().from(promoCodes);
const row = async (ref: string) => (await world.db.select().from(bookings).where(eq(bookings.ref, ref)))[0];
/** Dayglow for one hour ($78) with a pet ($40): $118. */
const withPet = (overrides: Parameters<TestWorld["book"]>[0] = {}) =>
  world.book({ studioIds: [world.ids.dayglow], durationMinutes: 60, addons: [{ addonId: petFeeId, quantity: 1 }], ...overrides });

describe("the pet fee on a booking", () => {
  it("is kept with the booking as a pet fee, whatever the add-on is called or becomes later", async () => {
    const booked = expectOk(await withPet());
    expect(booked.totalCents).toBe(11800);
    const { id } = await row(booked.ref);
    expect(await world.db.select({ kind: bookingAddons.kind }).from(bookingAddons).where(eq(bookingAddons.bookingId, id))).toEqual([{ kind: "pet" }]);
    expect(await petFeeCentsOf(world.db, id)).toBe(4000);

    // The owner renames the add-on and says it is for something else. This booking's fee is still a pet fee.
    await world.db.update(addons).set({ name: "Animal guest", kind: "other", priceCents: 9900 }).where(eq(addons.id, petFeeId));
    expect(await petFeeCentsOf(world.db, id)).toBe(4000);

    const plain = expectOk(await world.book({ date: FAR }));
    expect(await petFeeCentsOf(world.db, (await row(plain.ref)).id)).toBe(0);
  });
});

describe("cancelling a booking that has a pet fee", () => {
  it("in time: refunds the rest to the card, and returns the pet fee as studio credit", async () => {
    const booked = expectOk(await withPet({ date: FAR }));
    const before = await getManageChoices(world.db, booked.ref, byToken(booked.manageToken), NOW);
    expect(before?.cancel.text).toBe(
      "You will be refunded $74.10 to your card. The 5% processing fee ($3.90) is not refundable. The pet fee ($40) is not refunded to your card: it is returned as studio credit, and we email you the code.",
    );

    const result = expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    // $78 of studio less 5%; the $40 stays off the card, and the fee is not taken on it.
    expect(result).toMatchObject({ refundCents: 7410, feeCents: 390, creditCents: 4000, refund: "sent" });
    expect(world.refundCalls.map((call) => call.amountCents)).toEqual([7410]);

    const [credit] = await codes();
    expect(credit).toMatchObject({
      kind: "amount",
      value: 4000,
      source: "pet_fee",
      email: "jane@example.com",
      originBookingId: (await row(booked.ref)).id,
      expiresAt: daysAfter(NOW, 90),
    });
    expect(credit.code).toMatch(/^PET-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    const [mail] = await world.emails("booking_cancelled");
    expect(mail.body).toContain("A refund of $74.10 is on its way to your card ($3.90 processing fee kept)");
    expect(mail.body).toContain("The pet fee of $40 is not refunded to a card. It is returned to you as studio credit:");
    expect(mail.body).toContain(`Code: ${credit.code}`);
  });

  it("too late to be refunded: nothing comes back by itself, the pet fee included", async () => {
    const booked = expectOk(await withPet({ date: NEAR }));
    const result = expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    expect(result).toMatchObject({ refundCents: 0, creditCents: 0, refund: "none" });
    expect(await codes()).toHaveLength(0);
    expect(await world.db.select().from(refunds)).toHaveLength(0);
  });

  it("pays for the next booking like any credit, and comes back when that booking is cancelled", async () => {
    const first = expectOk(await withPet({ date: FAR }));
    expectOk(await cancelBooking(world.db, first.ref, byToken(first.manageToken), world.manageDeps()));
    const [credit] = await codes();

    // A two-hour booking in Blanche ($176) costs $136 with the $40.
    const next = expectOk(await world.book({ date: FAR, promoCode: credit.code }));
    expect(next.totalCents).toBe(13600);
    expect((await codes())[0].value).toBe(0);
    expect((await world.emails("booking_confirmation")).at(-1)!.body).toContain("Paid with your studio credit: $40");

    // It is studio credit, not a moved booking: cancelling in time refunds the card and gives the credit back.
    const result = expectOk(await cancelBooking(world.db, next.ref, byToken(next.manageToken), world.manageDeps()));
    expect(result.refundCents).toBe(13600 - 680);
    expect(result.message).toContain("The code you used for this booking can be used again.");
    expect((await codes())[0].value).toBe(4000);
  });
});

describe("the pet did not come", () => {
  const AFTER = new Date("2026-11-18T18:00:00Z"); // NEAR at 1:00 PM, after a 10:00 to 11:00 visit

  it("lets an owner return the fee as studio credit, once, and tells the client", async () => {
    const booked = expectOk(await withPet());
    const before = (await getAppointment(world.db, owner, booked.ref, AFTER))!;
    expect(before.petFee).toEqual({ cents: 4000, creditCode: null, canReturn: true, why: "" });

    const given = expectOk(await givePetFeeCredit(world.db, owner, booked.ref, { now: AFTER, baseUrl: BASE_URL }));
    expect(given.cents).toBe(4000);
    const [credit] = await codes();
    expect(credit).toMatchObject({ code: given.code, kind: "amount", value: 4000, source: "pet_fee", email: "jane@example.com", expiresAt: daysAfter(AFTER, 90) });
    // Nothing goes to the card.
    expect(world.refundCalls).toHaveLength(0);
    expect(await world.db.select().from(refunds)).toHaveLength(0);

    const [mail] = await world.emails("pet_credit");
    expect(mail.toEmail).toBe("jane@example.com");
    expect(mail.body).toContain("the pet fee of $40 is returned to you as studio credit");
    expect(mail.body).toContain(`Code: ${given.code}`);

    const after = (await getAppointment(world.db, owner, booked.ref, AFTER))!;
    expect(after.petFee).toMatchObject({ creditCode: given.code, canReturn: false });
    expect(after.history.at(-1)).toMatchObject({
      actor: "owner@studio.test",
      note: "The pet did not come: the pet fee of $40 was returned as studio credit",
    });

    // A second press gives nothing more.
    expect(await givePetFeeCredit(world.db, owner, booked.ref, deps())).toMatchObject({ ok: false, reason: "already_given" });
    expect(await codes()).toHaveLength(1);
  });

  it("gives one credit when the button is pressed twice at the same moment", async () => {
    const booked = expectOk(await withPet());
    const results = await Promise.all([givePetFeeCredit(world.db, owner, booked.ref, deps()), givePetFeeCredit(world.db, owner, booked.ref, deps())]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await codes()).toHaveLength(1);
    expect(await world.emails("pet_credit")).toHaveLength(1);
  });

  it("is the owners' decision: staff and customers cannot, and staff are not shown it", async () => {
    const booked = expectOk(await withPet());
    await world.db.execute(`insert into staff_shifts (user_id, day) values ('${sam.id}', '${NEAR}')`);
    expect(await givePetFeeCredit(world.db, sam, booked.ref, deps())).toMatchObject({ ok: false, reason: "forbidden" });
    expect((await getAppointment(world.db, sam, booked.ref, NOW))!.petFee).toBeNull();
    expect(await codes()).toHaveLength(0);
  });

  it("is not offered without a pet fee, or for a booking whose money moved to a reschedule code", async () => {
    const plain = expectOk(await world.book({ date: FAR }));
    expect((await getAppointment(world.db, owner, plain.ref, NOW))!.petFee).toBeNull();
    expect(await givePetFeeCredit(world.db, owner, plain.ref, deps())).toMatchObject({ ok: false, reason: "no_pet_fee" });

    // Released for a reschedule code: that code is worth everything paid, the pet fee included.
    const moved = expectOk(await withPet({ startMinute: h(14) }));
    const code = expectOk(await requestRescheduleCode(world.db, moved.ref, byToken(moved.manageToken), world.manageDeps()));
    expect(code.valueCents).toBe(11800);
    expect(await givePetFeeCredit(world.db, owner, moved.ref, deps())).toMatchObject({ ok: false, reason: "moved" });
    expect(await givePetFeeCredit(world.db, owner, "VS-NOPE22", deps())).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("is at the owner's discretion for a booking cancelled too late, and is not given twice with a cancellation in time", async () => {
    // Cancelled four days ahead: no refund. The owner can still return the pet fee.
    const late = expectOk(await withPet());
    expectOk(await cancelBooking(world.db, late.ref, byToken(late.manageToken), world.manageDeps()));
    expect((await getAppointment(world.db, owner, late.ref, NOW))!.petFee).toMatchObject({ canReturn: true });
    expect((await givePetFeeCredit(world.db, owner, late.ref, deps())).ok).toBe(true);

    // The owner returns the fee ahead of the visit, and the client then cancels in time:
    // the fee stays off the card, and no second credit is made.
    const early = expectOk(await withPet({ date: FAR }));
    expectOk(await givePetFeeCredit(world.db, owner, early.ref, deps()));
    const cancelled = expectOk(await cancelBooking(world.db, early.ref, byToken(early.manageToken), world.manageDeps()));
    expect(cancelled).toMatchObject({ refundCents: 7410, creditCents: 0 });
    expect((await codes()).filter((code) => code.source === "pet_fee")).toHaveLength(2); // one for each booking
  });

  it("once returned, is not given back again by moving the booking", async () => {
    const booked = expectOk(await withPet({ date: FAR }));
    expectOk(await givePetFeeCredit(world.db, owner, booked.ref, deps()));
    // The reschedule code carries the $78 of studio: the $40 came back already, as credit.
    const moved = expectOk(await requestRescheduleCode(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    expect(moved.valueCents).toBe(7800);
    expect((await codes()).map((code) => [code.source, code.value]).sort()).toEqual([
      ["pet_fee", 4000],
      ["reschedule", 7800],
    ]);
  });

  it("once returned, is not refunded to the card by the studio as well", async () => {
    const booked = expectOk(await withPet({ date: FAR }));
    expectOk(await givePetFeeCredit(world.db, owner, booked.ref, deps()));
    // The bookings list offers the card money less the fee, and the studio cannot send more.
    const [listed] = await listBookings(world.db, { from: FAR, to: FAR });
    expect(listed).toMatchObject({ ref: booked.ref, cardHeldCents: 11800, refundableCents: 7800 });
    const tooMuch = "At most $78 can be refunded to the card for this booking. Its pet fee of $40 was already returned as studio credit.";
    expect(await ownerRefund(world.db, booked.ref, { amountCents: 7801, reason: "" }, world.manageDeps())).toMatchObject({ ok: false, message: tooMuch });
    expect(await ownerCancelBooking(world.db, booked.ref, { refundCents: 11800 }, world.manageDeps())).toMatchObject({ ok: false, message: tooMuch });
    expectOk(await ownerCancelBooking(world.db, booked.ref, { refundCents: 7800 }, world.manageDeps()));
    expect(world.refundCalls.map((call) => call.amountCents)).toEqual([7800]);
  });

  it("has nothing to return once the studio refunded the whole booking to the card", async () => {
    const booked = expectOk(await withPet({ date: FAR }));
    expectOk(await ownerCancelBooking(world.db, booked.ref, { refundCents: 11800 }, world.manageDeps()));
    expect((await getAppointment(world.db, owner, booked.ref, NOW))!.petFee).toMatchObject({
      canReturn: false,
      why: "Less than the pet fee is held for this booking, so there is nothing to return.",
    });
    expect(await givePetFeeCredit(world.db, owner, booked.ref, deps())).toMatchObject({ ok: false, reason: "not_paid" });
  });
});
