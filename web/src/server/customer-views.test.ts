import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuthUser } from "./auth";
import { listCustomerViews, recordCustomerView, VIEW_GAP_MINUTES } from "./customer-views";
import { createTestWorld, minutesAfter, NOW, type TestWorld } from "./testing";

describe("the access log of the customers' pages (question 27)", () => {
  let world: TestWorld;
  beforeAll(async () => {
    world = await createTestWorld();
  });
  afterAll(() => world.close());
  beforeEach(() => world.reset());

  const owner: AuthUser = { id: "00000000-0000-4000-8000-000000000001", email: "owner@studio.test", name: "Olga", role: "owner" };
  const manager: AuthUser = { id: "00000000-0000-4000-8000-000000000002", email: "manager@studio.test", name: "", role: "manager" };

  it("writes who opened what and when, newest first, one line for the same thing opened again within minutes", async () => {
    expect(await recordCustomerView(world.db, owner, " Jane@Example.TEST ", "page", "", NOW)).toBe(true);
    expect(await recordCustomerView(world.db, owner, "jane@example.test", "page", "", minutesAfter(NOW, VIEW_GAP_MINUTES - 1))).toBe(false);
    expect(await recordCustomerView(world.db, owner, "jane@example.test", "receipt", "AB12CD", minutesAfter(NOW, 2))).toBe(true);
    expect(await recordCustomerView(world.db, owner, "jane@example.test", "receipt", "EF34GH", minutesAfter(NOW, 3))).toBe(true);
    expect(await recordCustomerView(world.db, manager, "jane@example.test", "page", "", minutesAfter(NOW, 4))).toBe(true);
    expect(await recordCustomerView(world.db, owner, "jane@example.test", "page", "", minutesAfter(NOW, VIEW_GAP_MINUTES + 1))).toBe(true);
    expect(await recordCustomerView(world.db, owner, "sam@example.test", "year", "2026", NOW)).toBe(true);
    expect(await recordCustomerView(world.db, owner, "not an address", "page", "", NOW)).toBe(false);

    const { views, total } = await listCustomerViews(world.db, "JANE@example.test");
    expect(total).toBe(5);
    expect(views.map((view) => [view.viewerEmail, view.viewerRole, view.what, view.detail])).toEqual([
      ["owner@studio.test", "owner", "page", ""],
      ["manager@studio.test", "manager", "page", ""],
      ["owner@studio.test", "owner", "receipt", "EF34GH"],
      ["owner@studio.test", "owner", "receipt", "AB12CD"],
      ["owner@studio.test", "owner", "page", ""],
    ]);
    expect(views[0]).toMatchObject({ viewerName: "Olga", viewedAt: minutesAfter(NOW, VIEW_GAP_MINUTES + 1).toISOString() });
    expect(await listCustomerViews(world.db, "jane@example.test", 2)).toMatchObject({ total: 5, views: [{ viewerEmail: "owner@studio.test" }, { viewerEmail: "manager@studio.test" }] });
    expect(await listCustomerViews(world.db, "nobody@example.test")).toEqual({ views: [], total: 0 });
  });
});
