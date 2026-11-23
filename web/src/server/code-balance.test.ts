import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { membershipMinutes, membershipPlanStudios, membershipPlans, memberships, promoCodes } from "@/db/schema";
import { checkCodeBalance } from "./code-balance";
import { createTestWorld, daysAfter, NOW, type TestWorld } from "./testing";

describe("Check Code Balance (the owner's brief of 2026-11-22, item 5)", () => {
  let world: TestWorld;
  beforeAll(async () => {
    world = await createTestWorld();
  });
  afterAll(() => world.close());
  beforeEach(() => world.reset());

  const balanceOf = async (code: string, now = NOW) => {
    const result = await checkCodeBalance(world.db, code, now);
    return result.found ? result.balance : null;
  };

  it("says what is left on a studio credit, a reschedule code and a discount, and whose it is not", async () => {
    await world.db.insert(promoCodes).values([
      { code: "CREDIT-AAAA-BBBB", kind: "amount", value: 7500, issuedCents: 10000, email: "jane@example.com" },
      { code: "MOVE-CCCC-DDDD", kind: "amount", value: 6800, issuedCents: 6800, source: "reschedule", email: "jane@example.com", expiresAt: new Date("2027-05-20T16:00:00Z") },
      { code: "SPRING20", kind: "percent", value: 20, maxUses: 2, usedCount: 1 },
    ]);
    expect(await balanceOf(" credit-aaaa-bbbb ")).toEqual({
      code: "CREDIT-AAAA-BBBB",
      title: "Studio credit",
      status: "usable",
      remaining: "$75 remaining",
      expires: null,
      restrictions: ["Pays for a studio rental and its add-ons. Not for photography sessions.", "Works only with the email address it was sent to."],
    });
    const moved = await balanceOf("MOVE-CCCC-DDDD");
    expect(moved).toMatchObject({ title: "Reschedule code", status: "usable", remaining: "$68 remaining", expires: "May 20, 2027" });
    expect(JSON.stringify(moved)).not.toContain("jane"); // never whose it is
    expect(await balanceOf("spring20")).toMatchObject({ title: "Discount code", status: "usable", remaining: "20% off, usable once", expires: null });
    expect((await balanceOf("SPRING20"))!.restrictions[0]).toBe("Takes its percentage off a studio rental, not off add-ons. Not for photography sessions.");
  });

  it("tells a code used up or expired from one that can be used, and changes nothing", async () => {
    await world.db.insert(promoCodes).values([
      { code: "CREDIT-USED-0000", kind: "amount", value: 0, issuedCents: 5000 },
      { code: "WINTER10", kind: "percent", value: 10, maxUses: 1, usedCount: 1 },
      { code: "LATE15", kind: "percent", value: 15, expiresAt: new Date("2026-11-01T04:00:00Z") },
      { code: "FREE-EEEE-FFFF", kind: "free_hour", value: 60, source: "loyalty", email: "jane@example.com", expiresAt: daysAfter(NOW, 180) },
      { code: "PHOTO25", kind: "percent", value: 25, photographyOnly: true, maxUses: 3 },
    ]);
    expect(await balanceOf("CREDIT-USED-0000")).toMatchObject({ status: "used", remaining: "$0 remaining" });
    expect(await balanceOf("WINTER10")).toMatchObject({ status: "used", remaining: "10% off" });
    expect(await balanceOf("LATE15")).toMatchObject({ status: "expired", expires: "Nov 1, 2026" });
    const free = await balanceOf("FREE-EEEE-FFFF");
    expect(free).toMatchObject({ title: "Free studio hour", status: "usable", remaining: "One free hour" });
    expect(free!.restrictions[0]).toContain("not for several studios booked together");
    expect(await balanceOf("PHOTO25")).toMatchObject({ remaining: "25% off, usable 3 times", restrictions: ["For photography sessions, not for studio rentals."] });

    const before = await world.db.select().from(promoCodes);
    await balanceOf("FREE-EEEE-FFFF");
    await balanceOf("PHOTO25");
    expect(await world.db.select().from(promoCodes)).toEqual(before);
  });

  it("gives a membership's minutes and the studios they are for, once it was paid for", async () => {
    const [plan] = await world.db.insert(membershipPlans).values({ name: "Paris monthly", minutes: 240, priceCents: 30000 }).returning();
    await world.db.insert(membershipPlanStudios).values({ planId: plan.id, studioId: world.ids.paris });
    const [member] = await world.db
      .insert(memberships)
      .values({ email: "jane@example.com", name: "Jane Smith", planId: plan.id, planName: plan.name, minutesPerMonth: 240, priceCents: 30000, code: "MEMBER-GGGG-HHHH", status: "active", requestKey: "k1", provider: "test", startedOn: "2026-11-01" })
      .returning();
    await world.db.insert(membershipMinutes).values([
      { membershipId: member.id, minutes: 240, kind: "month", actor: "system" },
      { membershipId: member.id, minutes: -60, kind: "correction", actor: "owner@studio.test" },
    ]);
    expect(await balanceOf("member-gggg-hhhh")).toEqual({
      code: "MEMBER-GGGG-HHHH",
      title: "Membership: Paris monthly",
      status: "usable",
      remaining: "180 minutes remaining",
      expires: null,
      restrictions: ["For studio rentals in Studio Paris, not for photography sessions.", "Works only with the email address of the membership."],
    });
    await world.db.insert(membershipMinutes).values({ membershipId: member.id, minutes: -180, kind: "correction", actor: "owner@studio.test" });
    expect(await balanceOf("MEMBER-GGGG-HHHH")).toMatchObject({ status: "used", remaining: "0 minutes remaining" });
    // One still being bought is not a code yet.
    await world.db.update(memberships).set({ status: "starting" }).where(eq(memberships.id, member.id));
    expect(await balanceOf("MEMBER-GGGG-HHHH")).toBeNull();
  });

  it("finds nothing for a code that does not exist, a cancelled one, or one too short or long to be a code", async () => {
    await world.db.insert(promoCodes).values({ code: "GONE-JJJJ-KKKK", kind: "amount", value: 2000, voidedAt: NOW });
    expect(await balanceOf("NOPE-0000-0000")).toBeNull();
    expect(await balanceOf("GONE-JJJJ-KKKK")).toBeNull();
    expect(await balanceOf("AB")).toBeNull();
    expect(await balanceOf("X".repeat(41))).toBeNull();
    expect(await checkCodeBalance(world.db, 42, NOW)).toEqual({ found: false });
  });
});
