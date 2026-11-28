import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ownDetails } from "./own-details";
import { createTestWorld, expectOk, FAR, h, hoursAfter, NOW, type TestWorld } from "./testing";

/**
 * A signed-in client's own details for the booking screen (the owners' decision of 2026-11-27; the preview test of
 * 2026-11-21, point 9: "A signed-in customer types their details again").
 */
let world: TestWorld;
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(() => world.reset());

describe("a signed-in client's own details", () => {
  it("are their account's address, with the name and phone number of their latest booking", async () => {
    const jane = await world.addUser("jane@example.com", "customer", "Jane");
    // No booking yet: the account's own name, and no phone number to give.
    expect(await ownDetails(world.db, jane)).toEqual({ name: "Jane", email: "jane@example.com", phone: "" });
    expectOk(await world.book({ date: FAR, customer: { name: "Jane Smith", email: "jane@example.com", phone: "407-555-0100" } }));
    expect(await ownDetails(world.db, jane)).toEqual({ name: "Jane Smith", email: "jane@example.com", phone: "407-555-0100" });
    // The latest booking's, when she has given another number since.
    expectOk(await world.book({ date: FAR, startMinute: h(14), customer: { name: "Jane S. Smith", email: "jane@example.com", phone: "(407) 555-0199" } }, { now: hoursAfter(NOW, 1) }));
    expect(await ownDetails(world.db, jane)).toEqual({ name: "Jane S. Smith", email: "jane@example.com", phone: "(407) 555-0199" });
  });

  it("are nobody else's: another client's bookings stay theirs", async () => {
    const jane = await world.addUser("jane@example.com", "customer", "Jane");
    expectOk(await world.book({ date: FAR, customer: { name: "Bob Brown", email: "bob@example.com", phone: "407-555-0111" } }));
    expect(await ownDetails(world.db, jane)).toEqual({ name: "Jane", email: "jane@example.com", phone: "" });
  });

  it("are not offered to a visitor, nor to an owner or a staff member, who book for others", async () => {
    expect(await ownDetails(world.db, null)).toBeNull();
    for (const role of ["owner", "manager", "staff"] as const) {
      const user = await world.addUser(`${role}@studio.test`, role, "Sam");
      expectOk(await world.book({ date: FAR, startMinute: h(role === "owner" ? 9 : role === "manager" ? 12 : 15), durationMinutes: 60, customer: { name: "Sam Staff", email: `${role}@studio.test`, phone: "407-555-0122" } }));
      expect(await ownDetails(world.db, user), role).toBeNull();
    }
  });
});
