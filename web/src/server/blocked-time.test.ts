import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { blocks } from "@/db/schema";
import { loadDayAvailability } from "./availability";
import { blockTimeText, createBlocks, daysOfPlan, listBlockSeries, planOf, removeBlocks, updateBlocks, type BlockPlan } from "./blocked-time";
import { loadCatalog } from "./catalog";
import { loadMonthFits } from "./month-availability";
import { createTestWorld, expectOk, NEAR, NOW, type TestWorld } from "./testing";

const h = (hours: number) => hours * 60;

describe("Availability & Blocked Time (the owner's admin brief of 2026-11-22, item 12)", () => {
  let world: TestWorld;
  beforeAll(async () => {
    world = await createTestWorld();
  });
  afterAll(() => world.close());
  beforeEach(() => world.reset());

  const plan = (overrides: Partial<BlockPlan>): BlockPlan => ({
    studioIds: [world.ids.blanche, world.ids.dayglow, world.ids.paris],
    from: "2026-12-24",
    to: "2026-12-26",
    wholeDay: true,
    startMinute: 0,
    endMinute: 0,
    weekdays: [],
    reason: "holiday",
    note: "",
    ...overrides,
  });

  it("closes every studio for December 24 to 26, and those days leave what clients can book", async () => {
    const closed = await createBlocks(world.db, plan({ note: "Christmas" }), NOW);
    expect(closed).toMatchObject({ ok: true, days: 3 });
    const catalog = await loadCatalog(world.db);
    const christmas = await loadDayAvailability(world.db, catalog, "2026-12-25", NOW);
    expect(christmas.days.every((studio) => studio.busy.some((span) => span.start <= h(9) && span.end >= h(19)))).toBe(true);
    const month = await loadMonthFits(world.db, catalog, { month: "2026-12", studioIds: [world.ids.paris], durationMinutes: 60, photography: false }, NOW);
    expect(month.ok && [month.days["2026-12-23"], month.days["2026-12-24"], month.days["2026-12-25"], month.days["2026-12-26"], month.days["2026-12-27"]]).toEqual([true, false, false, false, true]);
    // A bundle needs its studios free: none is.
    const bundle = await loadMonthFits(world.db, catalog, { month: "2026-12", studioIds: [world.ids.paris, world.ids.dayglow], durationMinutes: 60, photography: false }, NOW);
    expect(bundle.ok && bundle.days["2026-12-25"]).toBe(false);

    const [series] = await listBlockSeries(world.db, NOW);
    expect(series).toMatchObject({ reason: "holiday", note: "Christmas", studios: ["Studio Blanche", "Studio Dayglow", "Studio Paris"] });
    expect(series.days.map((day) => [day.date, blockTimeText(day)])).toEqual([
      ["2026-12-24", "Entire day"],
      ["2026-12-25", "Entire day"],
      ["2026-12-26", "Entire day"],
    ]);
    expect(planOf(series)).toMatchObject({ from: "2026-12-24", to: "2026-12-26", wholeDay: true, weekdays: [] });
  });

  it("blocks nothing over an appointment, and names it; nothing is cancelled", async () => {
    const booked = expectOk(await world.book()); // Blanche, NEAR, 10:00 AM to 12:00 PM
    const refused = await createBlocks(world.db, plan({ studioIds: [world.ids.blanche, world.ids.paris], from: NEAR, to: NEAR, reason: "maintenance" }), NOW);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.conflicts).toEqual([{ ref: booked.ref, customerName: "Jane Smith", studio: "Studio Blanche", day: "Wednesday, November 18, 2026", time: "10:00 AM – 12:00 PM" }]);
    expect(refused.message).toBe(
      `Nothing was blocked. An appointment holds part of that time: ${booked.ref} (Jane Smith, Studio Blanche, Wednesday, November 18, 2026, 10:00 AM – 12:00 PM). Move or cancel the appointments first, or leave that time out.`,
    );
    expect(await world.db.select().from(blocks)).toEqual([]);
    // The afternoon after the booking and its clean-up gap is free to block.
    expect((await createBlocks(world.db, plan({ studioIds: [world.ids.blanche], from: NEAR, to: NEAR, wholeDay: false, startMinute: h(12.25), endMinute: h(19) }), NOW)).ok).toBe(true);
    // And time already blocked is not blocked twice.
    const again = await createBlocks(world.db, plan({ studioIds: [world.ids.blanche], from: NEAR, to: NEAR, wholeDay: false, startMinute: h(15), endMinute: h(16) }), NOW);
    expect(again.ok === false && again.message).toMatch(/^Nothing was blocked\. Part of that time is blocked already: a block \(Studio Blanche.*\. Change that block instead, or leave that time out\.$/);
  });

  it("repeats every week on the days chosen, and is changed and removed as one", async () => {
    // Mondays, 9 to 11 in the morning, in Paris, from November 16 to December 14.
    const weekly = await createBlocks(world.db, plan({ studioIds: [world.ids.paris], from: "2026-11-16", to: "2026-12-14", weekdays: [1], wholeDay: false, startMinute: h(9), endMinute: h(11), reason: "private_event" }), NOW);
    expect(weekly).toMatchObject({ ok: true, days: 5 });
    let [series] = await listBlockSeries(world.db, NOW);
    expect(series.days.map((day) => day.date)).toEqual(["2026-11-16", "2026-11-23", "2026-11-30", "2026-12-07", "2026-12-14"]);
    expect(blockTimeText(series.days[0])).toBe("9:00 AM – 11:00 AM");
    expect(planOf(series)).toMatchObject({ weekdays: [1], wholeDay: false, startMinute: h(9), endMinute: h(11) });

    // Changed: the same Mondays, an hour later, with Blanche too. It does not stand in its own way.
    const changed = await updateBlocks(world.db, series.key, { ...planOf(series), studioIds: [world.ids.paris, world.ids.blanche], startMinute: h(10), endMinute: h(12) }, NOW);
    expect(changed).toMatchObject({ ok: true, key: series.key, days: 5 });
    [series] = await listBlockSeries(world.db, NOW);
    expect(series.studios).toEqual(["Studio Blanche", "Studio Paris"]);
    expect(blockTimeText(series.days[0])).toBe("10:00 AM – 12:00 PM");
    expect(await removeBlocks(world.db, series.key)).toBe(5);
    expect(await listBlockSeries(world.db, NOW)).toEqual([]);
  });

  it("refuses what cannot be blocked", async () => {
    const today = "2026-11-14";
    expect(daysOfPlan({ from: "2026-11-13", to: "", weekdays: [] }, today)).toBe("Choose a day from today on.");
    expect(daysOfPlan({ from: "2026-11-20", to: "2026-11-19", weekdays: [] }, today)).toBe("The last day must be on or after the first.");
    expect(daysOfPlan({ from: "2026-11-20", to: "2028-01-01", weekdays: [] }, today)).toBe("Block at most 370 days at a time.");
    expect(daysOfPlan({ from: "2026-11-17", to: "2026-11-18", weekdays: [1] }, today)).toBe("None of those days is one of the days of the week chosen.");
    expect(daysOfPlan({ from: "2026-11-20", to: "", weekdays: [] }, today)).toEqual(["2026-11-20"]);
    const refusal = async (overrides: Partial<BlockPlan>) => {
      const result = await createBlocks(world.db, plan(overrides), NOW);
      return result.ok ? null : result.message;
    };
    expect(await refusal({ studioIds: [] })).toBe("Choose at least one studio, or Select All Studios.");
    expect(await refusal({ studioIds: ["00000000-0000-4000-8000-000000000000"] })).toBe("Unknown studio.");
    expect(await refusal({ wholeDay: false, startMinute: h(12), endMinute: h(11) })).toBe("The end time must be after the start time.");
    expect(await refusal({ reason: "party" })).toBe("Choose a reason from the list.");
    expect(await world.db.select().from(blocks)).toEqual([]);
  });
});
