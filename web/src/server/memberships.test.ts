import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { STARTING_PLANS } from "@/db/seed";
import { addPlan, listPlans, planStudioChoices, savePlan, setPlanActive } from "./memberships";
import { createTestWorld, type TestWorld } from "./testing";

/** Follow-up 3, step 1 of the plan of 2026-11-18: the plans the owners sell. */
let world: TestWorld;
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(() => world.reset());

const input = (over: Partial<{ name: string; description: string; minutes: number; priceCents: number }> = {}) => ({
  name: "Paris, 3 hours a month",
  description: "",
  minutes: 180,
  priceCents: 19000,
  ...over,
});

describe("the membership plans", () => {
  it("start as the owners' table: 5 or 10 hours a month, in each studio and each bundle, all offered", async () => {
    const plans = await listPlans(world.db);
    expect(plans.map((plan) => [plan.studios.map((studio) => studio.slug).sort().join("+"), plan.minutes, plan.priceCents, plan.active])).toEqual([
      ["dayglow", 300, 33000, true],
      ["dayglow", 600, 60000, true],
      ["paris", 300, 30000, true],
      ["paris", 600, 55000, true],
      ["blanche", 300, 38000, true],
      ["blanche", 600, 70000, true],
      ["dayglow+paris", 300, 52000, true],
      ["dayglow+paris", 600, 95000, true],
      ["blanche+paris", 300, 66000, true],
      ["blanche+paris", 600, 120000, true],
      ["blanche+dayglow+paris", 300, 78000, true],
      ["blanche+dayglow+paris", 600, 145000, true],
    ]);
    expect(plans.map((plan) => plan.name)).toEqual(STARTING_PLANS.map((plan) => plan.name));
    expect(plans[0].description).toBe("Get creative in Studio Dayglow, the perfect space for vibrant, high-energy shoots.");
  });

  it("change their name, hours, price and description, never their studios, and can be switched off and on", async () => {
    const [first] = await listPlans(world.db);
    expect(await savePlan(world.db, first.id, input({ name: "  Dayglow   Five ", description: " Bright. ", minutes: 330, priceCents: 34000 }))).toEqual({ ok: true, id: first.id });
    expect(await setPlanActive(world.db, first.id, false)).toBe(true);
    const [changed] = await listPlans(world.db);
    expect(changed).toMatchObject({ name: "Dayglow Five", description: "Bright.", minutes: 330, priceCents: 34000, active: false });
    expect(changed.studios.map((studio) => studio.slug)).toEqual(["dayglow"]);
    expect(await setPlanActive(world.db, first.id, true)).toBe(true);
    expect((await listPlans(world.db))[0].active).toBe(true);
    expect(await setPlanActive(world.db, "not-a-plan", true)).toBe(false);
    expect(await savePlan(world.db, "00000000-0000-4000-8000-000000000000", input())).toEqual({ ok: false, message: "Unknown plan." });
  });

  it("refuse hours, prices and names the owners could not mean", async () => {
    const [first] = await listPlans(world.db);
    const hours = "Give the hours a month as whole or half hours, from 0.5 to 100.";
    const price = "Enter the price of a month as an amount up to $10,000, for example 330 or 330.50.";
    for (const minutes of [0, 15, 45, 6030, Number.NaN]) expect(await savePlan(world.db, first.id, input({ minutes }))).toEqual({ ok: false, message: hours });
    for (const priceCents of [0, -100, 1_000_001, 10.5]) expect(await savePlan(world.db, first.id, input({ priceCents }))).toEqual({ ok: false, message: price });
    expect(await savePlan(world.db, first.id, input({ name: "  " }))).toEqual({ ok: false, message: "Give the plan a name of up to 80 characters." });
    expect(await savePlan(world.db, first.id, input({ description: "x".repeat(501) }))).toEqual({ ok: false, message: "Keep the description under 500 characters." });
    expect(await savePlan(world.db, first.id, input({ minutes: 6000, priceCents: 1_000_000 }))).toMatchObject({ ok: true });
  });

  it("are added for a studio, or for studios that can be booked together, after the others", async () => {
    const { blanche, dayglow, paris } = world.ids;
    const added = await addPlan(world.db, [paris], input());
    expect(added).toMatchObject({ ok: true });
    const plans = await listPlans(world.db);
    expect(plans.at(-1)).toMatchObject({ name: "Paris, 3 hours a month", minutes: 180, priceCents: 19000, active: true, studios: [{ slug: "paris" }] });

    expect(await addPlan(world.db, [blanche, dayglow], input())).toEqual({
      ok: false,
      message: "A plan is for studios that can be booked together. To book Blanche and Dayglow together, add Paris or choose a different combination.",
    });
    const choose = "Choose the studio, or the studios of a bundle, the plan is for.";
    expect(await addPlan(world.db, [], input())).toEqual({ ok: false, message: choose });
    expect(await addPlan(world.db, [paris, paris], input())).toEqual({ ok: false, message: choose });
    expect(await addPlan(world.db, ["paris"], input())).toEqual({ ok: false, message: choose });
    expect(await addPlan(world.db, ["00000000-0000-4000-8000-000000000000"], input())).toEqual({ ok: false, message: "Unknown studio." });
    expect(await addPlan(world.db, [paris], input({ minutes: 20 }))).toMatchObject({ ok: false });
    expect(await listPlans(world.db)).toHaveLength(13);
  });

  it("are offered for each studio, and for each set of studios that can be booked together", async () => {
    const all = [
      { id: "b", name: "Studio Blanche", slug: "blanche" },
      { id: "d", name: "Studio Dayglow", slug: "dayglow" },
      { id: "p", name: "Studio Paris", slug: "paris" },
    ];
    expect(planStudioChoices(all)).toEqual([
      { ids: ["b"], label: "Studio Blanche" },
      { ids: ["d"], label: "Studio Dayglow" },
      { ids: ["p"], label: "Studio Paris" },
      { ids: ["b", "p"], label: "Studio Blanche and Studio Paris" },
      { ids: ["d", "p"], label: "Studio Dayglow and Studio Paris" },
      { ids: ["b", "d", "p"], label: "All the studios" },
    ]);
  });
});
