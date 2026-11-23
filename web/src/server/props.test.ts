import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bookings, media } from "@/db/schema";
import { saveAddon } from "./admin";
import { moveBooking } from "./appointments";
import type { AuthUser } from "./auth";
import { loadCatalog } from "./catalog";
import { deleteMedia, listMedia } from "./media";
import { propsFree, setPropAway, setPropPicture, upcomingReservations } from "./props";
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
    expect(await propsFree(world.db, localToUtc(NEAR, h(10)), localToUtc(NEAR, h(11)))).toEqual({ free: { [id]: 0 }, away: [] });
    expect(await propsFree(world.db, localToUtc(NEAR, h(12)), localToUtc(NEAR, h(13)))).toEqual({ free: { [id]: 1 }, away: [] });

    const reserved = (await upcomingReservations(world.db, NOW)).get(id)!;
    expect(reserved.map((reservation) => [reservation.ref === first.ref, reservation.customerName, reservation.quantity])).toEqual([
      [true, "Jane Smith", 1],
      [false, "Cara Cole", 1],
    ]);
    // A cancelled booking holds none.
    await world.db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.ref, first.ref));
    expect(await propsFree(world.db, localToUtc(NEAR, h(10)), localToUtc(NEAR, h(11)))).toEqual({ free: { [id]: 1 }, away: [] });
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

describe("a prop's picture, and days it is away (the admin brief of 2026-11-22, item 10)", () => {
  let world: TestWorld;
  let owner: AuthUser;
  beforeAll(async () => {
    world = await createTestWorld();
  });
  afterAll(() => world.close());
  beforeEach(async () => {
    await world.reset();
    owner = await world.addUser("owner@studio.test", "owner");
  });

  const wings = async () =>
    expectOk(await saveAddon(world.db, null, { name: "Angel wings", description: "", priceCents: 4000, kind: "other", studioId: null, stock: 1 })).id;
  const withWings = (id: string) => [{ addonId: id, quantity: 1 }];
  const bob = { name: "Bob Brown", email: "bob@example.com", phone: "407-555-0101" };
  const addPicture = async (alt: string) =>
    (
      await world.db
        .insert(media)
        .values({ fileKey: "test/wings.jpg", filename: "wings.jpg", contentType: "image/jpeg", size: 1000, width: 800, height: 600, alt, uploadedBy: "owner@studio.test" })
        .returning({ id: media.id })
    )[0].id;

  it("is not booked on the days it is away, says so on the booking page, and names the bookings made before", async () => {
    const id = await wings();
    // Booked before it goes away: NEAR is Wednesday, November 18.
    const before = expectOk(await world.book({ studioIds: [world.ids.blanche], startMinute: h(10), durationMinutes: 60, addons: withWings(id) }));
    const away = await setPropAway(world.db, owner, id, { from: "2026-11-17", to: NEAR }, NOW);
    expect(away).toEqual({
      ok: true,
      message: `Angel wings is away from Tuesday, November 17, 2026 to Wednesday, November 18, 2026: it cannot be booked then. A booking made before has it reserved then: ${before.ref} (Jane Smith). Tell that client, or change the booking.`,
    });
    // Nobody else can have it on those days, even at a free hour, and the booking page knows why.
    expect(await world.book({ studioIds: [world.ids.paris], startMinute: h(15), durationMinutes: 60, addons: withWings(id), customer: bob })).toMatchObject({
      ok: false,
      code: "prop_taken",
      message: "Angel wings: not available on that day. Please choose another day, or leave it out.",
    });
    expect(await propsFree(world.db, localToUtc(NEAR, h(15)), localToUtc(NEAR, h(16)))).toEqual({ free: { [id]: 0 }, away: [id] });
    // Nor moved onto them; the day after is as usual.
    const later = expectOk(await world.book({ studioIds: [world.ids.paris], date: "2026-11-19", startMinute: h(15), durationMinutes: 60, addons: withWings(id), customer: bob }));
    expect(await moveBooking(world.db, owner, later.ref, { date: NEAR, startMinute: h(15), countsAsClientMove: false }, NOW)).toMatchObject({ ok: false, reason: "slot_taken" });
    expect(await propsFree(world.db, localToUtc("2026-11-19", h(10)), localToUtc("2026-11-19", h(11)))).toEqual({ free: { [id]: 1 }, away: [] });

    // Back: it can be booked again.
    expect(await setPropAway(world.db, owner, id, null, NOW)).toEqual({ ok: true, message: "Angel wings can be booked again on every day." });
    expectOk(await world.book({ studioIds: [world.ids.paris], startMinute: h(15), durationMinutes: 60, addons: withWings(id), customer: bob }));
  });

  it("refuses days it cannot mark", async () => {
    const id = await wings();
    expect(await setPropAway(world.db, owner, id, { from: NEAR, to: "2026-11-17" }, NOW)).toEqual({ ok: false, message: "The last day cannot come before the first." });
    expect(await setPropAway(world.db, owner, id, { from: "2026-11-01", to: "2026-11-13" }, NOW)).toEqual({ ok: false, message: "Those days have passed. Choose days from today on." });
    expect(await setPropAway(world.db, owner, id, { from: "", to: "" }, NOW)).toMatchObject({ ok: false });
    // An add-on with no number is not a prop.
    const pet = expectOk(await saveAddon(world.db, null, { name: "Pet", description: "", priceCents: 3000, kind: "pet", studioId: null, stock: null })).id;
    expect(await setPropAway(world.db, owner, pet, { from: NEAR, to: NEAR }, NOW)).toMatchObject({ ok: false });
    // The owners'.
    const manager = await world.addUser("mia@studio.test", "manager");
    expect(await setPropAway(world.db, manager, id, { from: NEAR, to: NEAR }, NOW)).toMatchObject({ ok: false, message: "Only an owner can change a prop." });
  });

  it("has a picture the booking page shows, which the media library keeps while it is used", async () => {
    const id = await wings();
    expect(await setPropPicture(world.db, owner, id, await addPicture(""))).toEqual({
      ok: false,
      message: "Say what the picture wings.jpg shows first, in the media library. Then choose it here.",
    });
    const picture = await addPicture("A pair of white feathered angel wings");
    expect(await setPropPicture(world.db, owner, id, picture)).toEqual({ ok: true, message: "Picture chosen for Angel wings. Clients see it on the booking page now." });
    const offered = (await loadCatalog(world.db)).addons.find((addon) => addon.id === id)!;
    expect(offered.picture).toMatchObject({ id: picture, alt: "A pair of white feathered angel wings", width: 800, height: 600 });
    expect((await listMedia(world.db, owner))!.find((item) => item.id === picture)!.uses).toEqual([{ where: "add-on", name: "Angel wings" }]);
    expect(await deleteMedia(world.db, owner, picture)).toMatchObject({ ok: false, message: "This picture is shown in the add-on Angel wings. Take it out there first, then delete it." });
    expect(await setPropPicture(world.db, owner, id, "")).toEqual({ ok: true, message: "The picture of Angel wings is taken away." });
    expect((await loadCatalog(world.db)).addons.find((addon) => addon.id === id)!.picture).toBeNull();
  });
});
