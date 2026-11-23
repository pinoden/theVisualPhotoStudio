import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAdminBooking, freeStartsFor, moveBooking } from "./appointments";
import type { AuthUser } from "./auth";
import { editBooking } from "./edit-booking";
import { BASE_URL, createTestWorld, expectOk, FAR, h, NOW, type TestWorld } from "./testing";

/**
 * An owner's override of the opening hours (the owner's answer of 2026-11-23: "Only admin may override"; question 76
 * in ProjectLibrary.md): a booking made, moved or changed outside them, by an owner alone. Other bookings, the gap after
 * each and blocked time still stand. FAR is a Wednesday: the studios open 9 AM to 7 PM.
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
const early = (overrides: Record<string, unknown> = {}) => ({ studioIds: [world.ids.paris], date: FAR, startMinute: h(7), durationMinutes: 60, customer: client, ...overrides });
const deps = { now: NOW, baseUrl: BASE_URL };

describe("an owner's override of the opening hours", () => {
  it("books before the studios open, for an owner who asks for it only", async () => {
    expect(await createAdminBooking(world.db, owner, early(), deps)).toMatchObject({ ok: false, code: "slot_taken" });
    expect(await createAdminBooking(world.db, manager, early(), { ...deps, openAllDay: true })).toMatchObject({ ok: false, code: "slot_taken" });
    const made = expectOk(await createAdminBooking(world.db, owner, early(), { ...deps, openAllDay: true }));
    expect(made.ref).toMatch(/^VS-/);

    // The free times offered show the hours outside too, for the owner's form.
    const shown = await freeStartsFor(world.db, { studioIds: [world.ids.blanche], date: FAR, durationMinutes: 60, openAllDay: true }, NOW);
    expect(shown.ok && shown.starts.includes(h(6))).toBe(true);
    const usual = await freeStartsFor(world.db, { studioIds: [world.ids.blanche], date: FAR, durationMinutes: 60 }, NOW);
    expect(usual.ok && usual.starts.includes(h(6))).toBe(false);
  });

  it("still keeps other bookings and the gap after them", async () => {
    expectOk(await createAdminBooking(world.db, owner, early(), { ...deps, openAllDay: true }));
    // 7 to 8 AM is taken, with its 15 minutes after: 8:00 is not free, 8:15 is.
    expect(await createAdminBooking(world.db, owner, early({ startMinute: h(8), customer: { ...client, email: "eve@example.com" } }), { ...deps, openAllDay: true })).toMatchObject({ ok: false, code: "slot_taken" });
    expectOk(await createAdminBooking(world.db, owner, early({ startMinute: h(8) + 15, customer: { ...client, email: "eve@example.com" } }), { ...deps, openAllDay: true }));
  });

  it("moves a booking after closing, and changes one past it, for an owner only", async () => {
    const booked = expectOk(await world.book({ date: FAR, studioIds: [world.ids.paris], startMinute: h(17), durationMinutes: 60 }));
    const late = { date: FAR, startMinute: h(20), countsAsClientMove: false };
    expect(await moveBooking(world.db, owner, booked.ref, late, NOW)).toMatchObject({ ok: false, reason: "slot_taken" });
    expect(await moveBooking(world.db, manager, booked.ref, { ...late, openAllDay: true }, NOW)).toMatchObject({ ok: false, reason: "slot_taken" });
    expectOk(await moveBooking(world.db, owner, booked.ref, { ...late, openAllDay: true }, NOW));

    // From 8 PM, three hours end at 11 PM: past closing, with the override only.
    const three = { studioIds: [world.ids.paris], durationMinutes: 180, addons: [] };
    expect(await editBooking(world.db, owner, booked.ref, three, NOW)).toMatchObject({ ok: false, message: expect.stringContaining("inside the opening hours") });
    expect(await editBooking(world.db, owner, booked.ref, { ...three, openAllDay: true }, NOW)).toMatchObject({ ok: true });
  });
});
