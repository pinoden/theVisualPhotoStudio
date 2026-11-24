import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookings, studioHolds } from "@/db/schema";
import { createAdminBooking, freeStartsFor, moveBooking } from "./appointments";
import type { AuthUser } from "./auth";
import { createBlocks } from "./blocked-time";
import { editBooking } from "./edit-booking";
import { changeConflicts, confirmedKeys, conflictsFor, moveConflicts } from "./override";
import { BASE_URL, createTestWorld, expectOk, FAR, h, NOW, type TestWorld } from "./testing";

/**
 * An owner's override (the owner's answers of 2026-11-23: "Only admin may override", and "you just bring a pop up
 * notification, but if they press OK the appointments can override"; question 79 in ProjectLibrary.md): a time that
 * passes over the opening hours, another booking or blocked time is listed for the pop-up, and saved once each thing
 * on the list was read. FAR is a Wednesday: the studios open 9 AM to 7 PM, each keeping 15 minutes after a booking.
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

const client = { name: "Dana Diaz", email: "dana@example.com", phone: "407-555-0144" };
const at = (startMinute: number, overrides: Record<string, unknown> = {}) => ({
  studioIds: [world.ids.paris],
  date: FAR,
  startMinute,
  durationMinutes: 60,
  customer: client,
  ...overrides,
});
const deps = { now: NOW, baseUrl: BASE_URL };
const keys = (list: { key: string }[]) => list.map((conflict) => conflict.key);
const holdsOf = async (ref: string) => {
  const [booking] = await world.db.select({ id: bookings.id }).from(bookings).where(eq(bookings.ref, ref));
  return world.db.select().from(studioHolds).where(eq(studioHolds.bookingId, booking.id));
};

describe("an owner's override", () => {
  it("lists the opening hours a time passes over, and books it once they were read", async () => {
    const listed = await conflictsFor(world.db, owner, at(h(7)));
    expect(listed).toEqual([{ key: `hours:${world.ids.paris}`, text: expect.stringContaining("is open 9:00 AM–7:00 PM on Wednesdays"), overlaps: null }]);
    // Not read: refused, with what it passes over. Nothing listed for anyone but an owner.
    expect(await createAdminBooking(world.db, owner, at(h(7)), deps)).toMatchObject({ ok: false, code: "slot_taken" });
    expect(await createAdminBooking(world.db, owner, at(h(7)), { ...deps, override: [] })).toMatchObject({ ok: false, message: expect.stringContaining("is open 9:00 AM") });
    expect(await conflictsFor(world.db, manager, at(h(7)))).toEqual([]);
    expect(await createAdminBooking(world.db, manager, at(h(7)), { ...deps, override: keys(listed) })).toMatchObject({ ok: false, code: "slot_taken" });

    const made = expectOk(await createAdminBooking(world.db, owner, at(h(7)), { ...deps, override: keys(listed) }));
    // Outside the hours only: its hold overlaps nothing, and the database's rule still holds it.
    expect((await holdsOf(made.ref)).map((hold) => hold.overlapAllowed)).toEqual([false]);
  });

  it("books over another booking, which stays; nobody else can then take that time", async () => {
    const first = expectOk(await world.book({ date: FAR, studioIds: [world.ids.paris], startMinute: h(10), durationMinutes: 60 }));
    const listed = await conflictsFor(world.db, owner, at(h(10) + 30));
    expect(listed).toEqual([{ key: expect.stringMatching(/^hold:/), text: expect.stringContaining(`(${first.ref}), 10:00 AM–11:00 AM, and the gap after it`), overlaps: world.ids.paris }]);

    const made = expectOk(await createAdminBooking(world.db, owner, at(h(10) + 30, { customer: { ...client, email: "eve@example.com" } }), { ...deps, override: keys(listed) }));
    expect((await holdsOf(made.ref)).map((hold) => hold.overlapAllowed)).toEqual([true]);
    expect((await holdsOf(first.ref)).map((hold) => hold.active)).toEqual([true]);
    // 11:15 is free of the first booking and its gap, not of the owner's: a client cannot book into it.
    expect(await world.book({ date: FAR, studioIds: [world.ids.paris], startMinute: h(11) + 15, durationMinutes: 60 })).toMatchObject({ ok: false, code: "slot_taken" });
  });

  it("lists blocked time, with its note", async () => {
    expectOk(await createBlocks(world.db, { studioIds: [world.ids.paris], from: FAR, to: FAR, wholeDay: false, startMinute: h(15), endMinute: h(16), weekdays: [], reason: "maintenance", note: "Painting" }, NOW));
    const listed = await conflictsFor(world.db, owner, at(h(15)));
    expect(listed.map((conflict) => conflict.text)).toEqual([expect.stringMatching(/blocked 3:00 PM–4:00 PM.*Painting/)]);
    expectOk(await createAdminBooking(world.db, owner, at(h(15)), { ...deps, override: keys(listed) }));
  });

  it("refuses what came in the way after the pop-up was read", async () => {
    const read = keys(await conflictsFor(world.db, owner, at(h(7))));
    expectOk(await world.book({ date: FAR, studioIds: [world.ids.paris], startMinute: h(9), durationMinutes: 60 }));
    // From 7:30 to 9:30 now passes over the new booking too, which was not on the list.
    const refused = await createAdminBooking(world.db, owner, at(h(7) + 30, { durationMinutes: 120 }), { ...deps, override: read });
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining("9:00 AM–10:00 AM") });
  });

  it("moves a booking over another, and a later move to a free time marks it no longer", async () => {
    const other = expectOk(await world.book({ date: FAR, studioIds: [world.ids.paris], startMinute: h(14), durationMinutes: 60 }));
    const moving = expectOk(await world.book({ date: FAR, studioIds: [world.ids.paris], startMinute: h(16), durationMinutes: 60 }));
    const listed = await moveConflicts(world.db, owner, moving.ref, FAR, h(14));
    expect(listed.map((conflict) => conflict.text)).toEqual([expect.stringContaining(other.ref)]);
    expect(await moveBooking(world.db, owner, moving.ref, { date: FAR, startMinute: h(14), countsAsClientMove: false }, NOW)).toMatchObject({ ok: false, reason: "slot_taken" });
    expect(await moveBooking(world.db, manager, moving.ref, { date: FAR, startMinute: h(14), countsAsClientMove: false, override: keys(listed) }, NOW)).toMatchObject({ ok: false });
    expectOk(await moveBooking(world.db, owner, moving.ref, { date: FAR, startMinute: h(14), countsAsClientMove: false, override: keys(listed) }, NOW));
    expect((await holdsOf(moving.ref)).map((hold) => hold.overlapAllowed)).toEqual([true]);

    expectOk(await moveBooking(world.db, owner, moving.ref, { date: FAR, startMinute: h(17), countsAsClientMove: false, override: [] }, NOW));
    expect((await holdsOf(moving.ref)).map((hold) => hold.overlapAllowed)).toEqual([false]);
  });

  it("changes a booking to four hours, over the next one and past closing, once read", async () => {
    const booked = expectOk(await world.book({ date: FAR, studioIds: [world.ids.paris], startMinute: h(16), durationMinutes: 60 }));
    const next = expectOk(await world.book({ date: FAR, studioIds: [world.ids.paris], startMinute: h(18), durationMinutes: 60 }));
    const four = { studioIds: [world.ids.paris], durationMinutes: 240, addons: [] };
    expect(await editBooking(world.db, owner, booked.ref, four, NOW)).toMatchObject({ ok: false, message: expect.stringContaining("inside the opening hours") });
    const listed = await changeConflicts(world.db, owner, booked.ref, four);
    expect(listed.map((conflict) => conflict.text)).toEqual([expect.stringContaining("is open 9:00 AM–7:00 PM"), expect.stringContaining(next.ref)]);
    expect(await editBooking(world.db, owner, booked.ref, { ...four, override: keys(listed) }, NOW)).toMatchObject({ ok: true });
  });

  it("offers an owner's form every start of the day, with what each passes over", async () => {
    expectOk(await world.book({ date: FAR, studioIds: [world.ids.blanche], startMinute: h(12), durationMinutes: 60 }));
    const shown = await freeStartsFor(world.db, { studioIds: [world.ids.blanche], date: FAR, durationMinutes: 60, anyTime: true }, NOW);
    if (!shown.ok) throw new Error(shown.message);
    expect(shown.starts[0]).toBe(0);
    expect(shown.starts).toContain(h(23));
    expect(shown.passes?.[h(6)]).toEqual([expect.stringContaining("is open")]);
    expect(shown.passes?.[h(12)]).toEqual([expect.stringContaining("’s booking")]);
    expect(shown.passes?.[h(10)]).toBeUndefined();
    const usual = await freeStartsFor(world.db, { studioIds: [world.ids.blanche], date: FAR, durationMinutes: 60 }, NOW);
    expect(usual.ok && usual.starts.includes(h(6))).toBe(false);
  });

  it("reads the pop-up's keys, and nothing else, from the form", () => {
    const id = "0b7f3c1e-1f7a-4d33-9c51-6a2b8f0e9d10";
    expect(confirmedKeys(null)).toBeNull();
    expect(confirmedKeys("")).toEqual([]);
    expect(confirmedKeys(`hours:${id} hold:${id}  person-hours person-hold:${id} drop table`)).toEqual([`hours:${id}`, `hold:${id}`, "person-hours", `person-hold:${id}`]);
  });
});
