import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bookings } from "@/db/schema";
import { saveAddon } from "./admin";
import { moveBooking } from "./appointments";
import type { AuthUser } from "./auth";
import { propsFree, upcomingReservations } from "./props";
import { createTestWorld, expectOk, NEAR, NOW, type TestWorld } from "./testing";
import { localToUtc } from "./tz";

const h = (hours: number) => hours * 60;

describe("Props & Resources (the owner's admin brief of 2026-11-22, item 10)", () => {
  let world: TestWorld;
  beforeAll(async () => {
    world = await createTestWorld();
  });
  afterAll(() => world.close());
  beforeEach(() => world.reset());

  /** One pair of angel wings, $40, for any booking. */
  const wings = async (stock: number) =>
    expectOk(await saveAddon(world.db, null, { name: "Angel wings", description: "", priceCents: 4000, kind: "other", studioId: null, stock })).id;
  const withWings = (id: string) => [{ addonId: id, quantity: 1 }];

  it("books the one pair once for any overlapping time, in any studio, and again when the first is over", async () => {
    const id = await wings(1);
    const first = expectOk(await world.book({ studioIds: [world.ids.blanche], startMinute: h(10), durationMinutes: 60, addons: withWings(id) }));
    // Paris at 10:30: the wings are on the set in Blanche.
    expect(await world.book({ studioIds: [world.ids.paris], startMinute: h(10.5), durationMinutes: 60, addons: withWings(id) })).toEqual({
      ok: false,
      status: 409,
      code: "prop_taken",
      message: "Angel wings: already reserved at that time. Please choose another time, or leave it out.",
    });
    // Without them, Paris at 10:30 is booked.
    expectOk(await world.book({ studioIds: [world.ids.paris], startMinute: h(10.5), durationMinutes: 60, customer: { name: "Bob Brown", email: "bob@example.com", phone: "407-555-0101" } }));
    // From 11:00, when Blanche's hour is over, they are free.
    expectOk(await world.book({ studioIds: [world.ids.dayglow], startMinute: h(11), durationMinutes: 60, addons: withWings(id), customer: { name: "Cara Cole", email: "cara@example.com", phone: "407-555-0102" } }));
    expect(await propsFree(world.db, localToUtc(NEAR, h(10)), localToUtc(NEAR, h(11)))).toEqual({ [id]: 0 });
    expect(await propsFree(world.db, localToUtc(NEAR, h(12)), localToUtc(NEAR, h(13)))).toEqual({ [id]: 1 });

    const reserved = (await upcomingReservations(world.db, NOW)).get(id)!;
    expect(reserved.map((reservation) => [reservation.ref === first.ref, reservation.customerName, reservation.quantity])).toEqual([
      [true, "Jane Smith", 1],
      [false, "Cara Cole", 1],
    ]);
    // A cancelled booking holds none.
    await world.db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.ref, first.ref));
    expect(await propsFree(world.db, localToUtc(NEAR, h(10)), localToUtc(NEAR, h(11)))).toEqual({ [id]: 1 });
  });

  it("books as many as there are, once a second pair is bought", async () => {
    const id = await wings(2);
    expectOk(await world.book({ studioIds: [world.ids.blanche], startMinute: h(10), durationMinutes: 60, addons: withWings(id) }));
    expectOk(await world.book({ studioIds: [world.ids.paris], startMinute: h(10), durationMinutes: 60, addons: withWings(id), customer: { name: "Bob Brown", email: "bob@example.com", phone: "407-555-0101" } }));
    expect(await world.book({ studioIds: [world.ids.dayglow], startMinute: h(10), durationMinutes: 60, addons: withWings(id), customer: { name: "Cara Cole", email: "cara@example.com", phone: "407-555-0102" } })).toMatchObject({
      code: "prop_taken",
      message: "Angel wings: already reserved at that time (all 2). Please choose another time, or leave them out.",
    });
  });

  it("moves a booking only to a time its props are free at", async () => {
    const owner: AuthUser = await world.addUser("owner@studio.test", "owner");
    const id = await wings(1);
    expectOk(await world.book({ studioIds: [world.ids.blanche], startMinute: h(10), durationMinutes: 60, addons: withWings(id) }));
    const later = expectOk(await world.book({ studioIds: [world.ids.paris], startMinute: h(14), durationMinutes: 60, addons: withWings(id), customer: { name: "Bob Brown", email: "bob@example.com", phone: "407-555-0101" } }));
    expect(await moveBooking(world.db, owner, later.ref, { date: NEAR, startMinute: h(10), countsAsClientMove: false }, NOW)).toEqual({
      ok: false,
      reason: "slot_taken",
      message: "Angel wings: already reserved at that time. Please choose another time, or leave it out.",
    });
    // Its own time does not stand in its own way: an hour later is fine.
    expectOk(await moveBooking(world.db, owner, later.ref, { date: NEAR, startMinute: h(15), countsAsClientMove: false }, NOW));
  });

  it("refuses a number of props it cannot keep", async () => {
    const base = { name: "Stands", description: "", priceCents: 1000, kind: "other" as const, studioId: null };
    expect(await saveAddon(world.db, null, { ...base, stock: 0 })).toMatchObject({ ok: false });
    expect(await saveAddon(world.db, null, { ...base, stock: 1.5 })).toMatchObject({ ok: false });
    expect(await saveAddon(world.db, null, { ...base, stock: 101 })).toMatchObject({ ok: false });
    expect((await saveAddon(world.db, null, { ...base, stock: null })).ok).toBe(true);
  });
});
