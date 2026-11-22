import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addons, bookingAddons } from "@/db/schema";
import { listAddons, listInactiveStudios, saveAddon, saveStudioDetails, setAddonActive, setStudioActive, type AdminAddon } from "./admin";
import { bookings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { loadCatalog } from "./catalog";
import { createTestWorld, daysAfter, expectOk, FAR, h, NEAR, NOW, type TestWorld } from "./testing";

let world: TestWorld;
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(() => world.reset());

const paris = async () => (await loadCatalog(world.db)).studios.find((studio) => studio.slug === "paris")!;
const DETAILS = { tagline: "A line", description: "Some words.", includedGuests: 5, bufferMinutes: 20 };

describe("what the owner can change about a studio", () => {
  it("is what customers read and what the catalog carries", async () => {
    expect(await saveStudioDetails(world.db, world.ids.paris, { ...DETAILS, tagline: "  A line  " })).toBe(true);
    expect(await paris()).toMatchObject(DETAILS);
  });

  it("includes its name, which keeps its address on the site and cannot be another studio's (question 29)", async () => {
    expect(await saveStudioDetails(world.db, world.ids.paris, { ...DETAILS, name: "  Studio   Lumière " })).toBe(true);
    expect(await paris()).toMatchObject({ name: "Studio Lumière", slug: "paris" });
    const booked = expectOk(await world.book({ studioIds: [world.ids.paris] }));
    expect((await world.emails("booking_confirmation")).at(-1)!.body).toContain("Studio Lumière");
    expect(booked.ref).toBeTruthy();
    const blancheName = (await loadCatalog(world.db)).studios.find((studio) => studio.slug === "blanche")!.name;
    for (const name of [blancheName.toUpperCase(), "", "   ", "x".repeat(61)]) {
      expect(await saveStudioDetails(world.db, world.ids.paris, { ...DETAILS, name })).toBe(false);
    }
    // Without a name, it stays as it is.
    expect(await saveStudioDetails(world.db, world.ids.paris, DETAILS)).toBe(true);
    expect((await paris()).name).toBe("Studio Lumière");
  });

  it("is refused, changing nothing, when a number is out of range, a text is too long or the studio is unknown", async () => {
    const before = await paris();
    const refused = [
      { ...DETAILS, includedGuests: 0 },
      { ...DETAILS, includedGuests: 2.5 },
      { ...DETAILS, bufferMinutes: -5 },
      { ...DETAILS, bufferMinutes: 241 },
      { ...DETAILS, tagline: "x".repeat(201) },
      { ...DETAILS, description: "x".repeat(2001) },
    ];
    for (const details of refused) expect(await saveStudioDetails(world.db, world.ids.paris, details)).toBe(false);
    expect(await saveStudioDetails(world.db, "not-a-studio", DETAILS)).toBe(false);
    expect(await saveStudioDetails(world.db, "00000000-0000-4000-8000-000000000000", DETAILS)).toBe(false);
    expect(await paris()).toEqual(before);
  });

  it("includes the clean-up time, which bookings made afterwards keep free", async () => {
    // With the usual ten minutes, the next hour cannot start as the first one ends.
    expectOk(await world.book());
    expect(await world.book({ startMinute: h(12), durationMinutes: 60 })).toMatchObject({ ok: false, code: "slot_taken" });

    // With none, two bookings can follow each other directly.
    const blanche = (await loadCatalog(world.db)).studios.find((studio) => studio.slug === "blanche")!;
    expect(
      await saveStudioDetails(world.db, blanche.id, {
        tagline: blanche.tagline,
        description: blanche.description,
        includedGuests: blanche.includedGuests,
        bufferMinutes: 0,
      }),
    ).toBe(true);
    expectOk(await world.book({ date: FAR }));
    expectOk(await world.book({ date: FAR, startMinute: h(12), durationMinutes: 60 }));
  });
});

const fields = (addon: AdminAddon) => ({
  name: addon.name,
  description: addon.description,
  priceCents: addon.priceCents,
  kind: addon.kind,
  studioId: addon.studioId,
});
const petFee = async () => (await listAddons(world.db)).find((addon) => addon.slug === "pet-fee")!;
const offered = async () => (await loadCatalog(world.db)).addons.map((addon) => addon.slug);

describe("what the owner can change about add-ons", () => {
  it("is a new price for new bookings, while a booking already made keeps what it paid", async () => {
    const pet = await petFee();
    expect(pet).toMatchObject({ name: "Pet fee", priceCents: 4000, studioId: world.ids.dayglow, active: true });
    expectOk(await world.book({ studioIds: [world.ids.dayglow], addons: [{ addonId: pet.id, quantity: 1 }] }));

    expect(await saveAddon(world.db, pet.id, { ...fields(pet), name: "Pet  fee (per visit)", priceCents: 4500 })).toEqual({
      ok: true,
      id: pet.id,
    });
    const now = (await loadCatalog(world.db)).addons.find((addon) => addon.id === pet.id)!;
    expect(now).toMatchObject({ slug: "pet-fee", name: "Pet fee (per visit)", priceCents: 4500 });
    expect((await world.db.select().from(bookingAddons))[0]).toMatchObject({ name: "Pet fee", unitCents: 4000 });
  });

  it("can gain a new add-on, listed after the others with a name of its own in addresses", async () => {
    const count = (await listAddons(world.db)).length;
    const steamer = await saveAddon(world.db, null, {
      name: "Steamer rental",
      description: "A garment steamer for the session.",
      priceCents: 1500,
      kind: "other",
      studioId: null,
    });
    const second = await saveAddon(world.db, null, { ...fields(await petFee()), studioId: null });
    expect(steamer.ok && second.ok).toBe(true);

    const all = await listAddons(world.db);
    expect(all.map((addon) => addon.slug).slice(count)).toEqual(["steamer-rental", "pet-fee-2"]);
    expect(await offered()).toContain("steamer-rental");
  });

  it("starts with what each of the first add-ons is for, and lets the owner say it for any other", async () => {
    expect((await listAddons(world.db)).map((addon) => [addon.slug, addon.kind])).toEqual([
      ["extra-guest", "people"],
      ["pet-fee", "pet"],
    ]);
    const dogs = await saveAddon(world.db, null, {
      name: "Dog visit",
      description: "",
      priceCents: 2500,
      kind: "pet",
      studioId: world.ids.paris,
    });
    expect(dogs.ok).toBe(true);
    // The guest information page reads the kind from the catalog, whatever the add-on is called.
    const inCatalog = (await loadCatalog(world.db)).addons.find((addon) => addon.slug === "dog-visit")!;
    expect(inCatalog).toMatchObject({ kind: "pet", studioId: world.ids.paris, maxQuantity: 1 });
  });

  it("is refused without a name, with a bad price or kind, or for an unknown studio or add-on", async () => {
    const pet = await petFee();
    const good = fields(pet);
    expect(await saveAddon(world.db, pet.id, { ...good, name: "   " })).toMatchObject({ ok: false });
    expect(await saveAddon(world.db, pet.id, { ...good, name: "x".repeat(81) })).toMatchObject({ ok: false });
    expect(await saveAddon(world.db, pet.id, { ...good, description: "x".repeat(301) })).toMatchObject({ ok: false });
    expect(await saveAddon(world.db, pet.id, { ...good, priceCents: -1 })).toMatchObject({ ok: false });
    expect(await saveAddon(world.db, pet.id, { ...good, priceCents: 40.5 })).toMatchObject({ ok: false });
    expect(await saveAddon(world.db, pet.id, { ...good, kind: "gift" as never })).toEqual({
      ok: false,
      message: "Choose what the add-on is for.",
    });
    expect(await saveAddon(world.db, pet.id, { ...good, studioId: "not-a-studio" })).toEqual({ ok: false, message: "Unknown studio." });
    expect(await saveAddon(world.db, "not-an-add-on", good)).toEqual({ ok: false, message: "Unknown add-on." });
    expect(await saveAddon(world.db, "00000000-0000-4000-8000-000000000000", good)).toEqual({
      ok: false,
      message: "Unknown add-on.",
    });
    expect(await petFee()).toEqual(pet);
  });

  it("can stop being offered without being deleted, and be offered again", async () => {
    const pet = await petFee();
    expectOk(await world.book({ studioIds: [world.ids.dayglow], addons: [{ addonId: pet.id, quantity: 1 }] }));

    expect(await setAddonActive(world.db, pet.id, false)).toBe(true);
    expect(await offered()).not.toContain("pet-fee");
    expect((await petFee()).active).toBe(false);
    expect(await world.db.select().from(addons)).toHaveLength((await listAddons(world.db)).length);
    // A booking can no longer include it, and the earlier booking still has it.
    expect(
      (await world.book({ date: FAR, studioIds: [world.ids.dayglow], addons: [{ addonId: pet.id, quantity: 1 }] })).ok,
    ).toBe(false);
    expect(await world.db.select().from(bookingAddons)).toHaveLength(1);

    expect(await setAddonActive(world.db, pet.id, true)).toBe(true);
    expect(await offered()).toContain("pet-fee");
    expect(await setAddonActive(world.db, "not-an-add-on", false)).toBe(false);
  });
});

describe("a studio taken off the site and put back (question 29)", () => {
  it("is offered nowhere while off, keeps its past, and stays while a booking still to come holds it", async () => {
    const booked = expectOk(await world.book({ studioIds: [world.ids.paris] }));
    expect(await setStudioActive(world.db, world.ids.paris, false, NOW)).toEqual({ ok: false, code: "booked", bookings: 1 });
    expect((await paris())).toBeTruthy();

    // Once the visit is over, it can go.
    const later = daysAfter(new Date(`${NEAR}T12:00:00Z`), 2);
    expect(await setStudioActive(world.db, world.ids.paris, false, later)).toEqual({ ok: true });
    expect((await loadCatalog(world.db)).studios.map((studio) => studio.slug)).not.toContain("paris");
    expect(await listInactiveStudios(world.db)).toEqual([expect.objectContaining({ id: world.ids.paris, slug: "paris" })]);
    expect(await world.book({ studioIds: [world.ids.paris], date: FAR })).toMatchObject({ ok: false });
    // Its booking is still there, as it was.
    expect((await world.db.select().from(bookings).where(eq(bookings.ref, booked.ref)))[0].status).toBe("confirmed");

    expect(await setStudioActive(world.db, world.ids.paris, true, later)).toEqual({ ok: true });
    expect((await loadCatalog(world.db)).studios.map((studio) => studio.slug)).toContain("paris");
    expect(await listInactiveStudios(world.db)).toEqual([]);
    expect(await setStudioActive(world.db, "not-a-studio", false, NOW)).toEqual({ ok: false, code: "unknown" });
  });
});
