import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBlock } from "./admin";
import { loadCatalog } from "./catalog";
import { datesOfMonth, loadMonthFits } from "./month-availability";
import { createTestWorld, NOW, type TestWorld } from "./testing";

const h = (hours: number) => hours * 60;

describe("the days of a month a booking fits on (the owner's brief of 2026-11-22, item 3)", () => {
  let world: TestWorld;
  beforeAll(async () => {
    world = await createTestWorld();
  });
  afterAll(() => world.close());
  beforeEach(() => world.reset());

  // NOW is Saturday 2026-11-14. Wednesday the 18th is a weekday well inside the booking window.
  const DAY = "2026-11-18";
  const fits = async (studioIds: string[], minutes: number, month = "2026-11") => {
    const result = await loadMonthFits(world.db, await loadCatalog(world.db), { month, studioIds, durationMinutes: minutes, photography: false }, NOW);
    if (!result.ok) throw new Error(result.message);
    return result.days;
  };

  it("offers a day only for a length that fits on it, not for any free time that day", async () => {
    // Blanche is free on the 18th only from 2:00 to 3:30 PM: one hour and its clean-up gap fit, two hours do not.
    expect((await createBlock(world.db, { studioIds: [world.ids.blanche], date: DAY, startMinute: h(9), endMinute: h(14), note: "" })).ok).toBe(true);
    expect((await createBlock(world.db, { studioIds: [world.ids.blanche], date: DAY, startMinute: h(15.5), endMinute: h(19), note: "" })).ok).toBe(true);
    expect((await fits([world.ids.blanche], 60))[DAY]).toBe(true);
    expect((await fits([world.ids.blanche], 120))[DAY]).toBe(false);
    // The day after is free for either.
    expect((await fits([world.ids.blanche], 120))["2026-11-19"]).toBe(true);
  });

  it("needs every studio of a bundle free at once", async () => {
    expect((await createBlock(world.db, { studioIds: [world.ids.dayglow], date: DAY, startMinute: h(9), endMinute: h(19), note: "Closed" })).ok).toBe(true);
    expect((await fits([world.ids.paris], 60))[DAY]).toBe(true);
    expect((await fits([world.ids.paris, world.ids.dayglow], 60))[DAY]).toBe(false);
    expect((await fits([world.ids.paris, world.ids.dayglow], 60))["2026-11-19"]).toBe(true);
  });

  it("offers no day already past, and none beyond how far ahead bookings open", async () => {
    const november = await fits([world.ids.blanche], 60);
    expect(Object.keys(november)).toEqual(datesOfMonth("2026-11"));
    expect(november["2026-11-02"]).toBe(false);
    expect(november["2026-11-13"]).toBe(false);
    const far = await fits([world.ids.blanche], 60, "2028-01");
    expect(Object.values(far).every((day) => day === false)).toBe(true);
  });

  it("refuses what cannot be booked: Blanche and Dayglow without Paris, a length of nothing, no studio, no month", async () => {
    const catalog = await loadCatalog(world.db);
    const ask = (input: Partial<Parameters<typeof loadMonthFits>[2]>) =>
      loadMonthFits(world.db, catalog, { month: "2026-11", studioIds: [world.ids.blanche], durationMinutes: 60, photography: false, ...input }, NOW);
    expect(await ask({ studioIds: [world.ids.blanche, world.ids.dayglow] })).toEqual({ ok: false, message: "To book Blanche and Dayglow together, add Paris or choose a different combination." });
    expect((await ask({ durationMinutes: 0 })).ok).toBe(false);
    expect((await ask({ studioIds: [] })).ok).toBe(false);
    expect((await ask({ studioIds: ["00000000-0000-4000-8000-000000000000"] })).ok).toBe(false);
    expect((await ask({ month: "2026-13" })).ok).toBe(false);
    expect((await ask({ photography: true, durationMinutes: 7 })).ok).toBe(false);
    expect(datesOfMonth("2028-02")).toHaveLength(29);
  });
});
