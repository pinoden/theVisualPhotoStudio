import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { bookings, loyaltyLedger, promoCodes, settings } from "@/db/schema";
import { createManualCode, voidCode } from "./admin";
import type { AuthUser } from "./auth";
import { FREE_HOUR_MINUTES, listStampChanges, loyaltyStandingOf } from "./loyalty";
import { cancelBooking } from "./manage";
import { adjustStamps, cancelReward, listRewardChanges, listRewards, restoreReward } from "./rewards";
import { DEFAULT_SETTINGS } from "./settings";
import { completeVisits } from "./tasks";
import { BASE_URL, createTestWorld, daysAfter, expectOk, FAR, minutesAfter, NOW, type TestWorld } from "./testing";

/**
 * The owner's client portal, "My Rewards": every reward with its code, its
 * dates and one of four statuses, and administrators who can correct stamps
 * and reward statuses by hand, with a record of each correction.
 */
let world: TestWorld;
let owner: AuthUser;
let sam: AuthUser; // staff
let jane: AuthUser; // the customer herself

beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser("owner@studio.test", "owner", "Olivia");
  sam = await world.addUser("sam@studio.test", "staff", "Sam");
  jane = await world.addUser("jane@example.com", "customer", "Jane");
});

const JANE = "jane@example.com";
const DAYS = ["2026-11-18", "2026-11-19", "2026-11-20", "2026-11-23", "2026-11-24"];
const evening = (date: string) => new Date(`${date}T23:00:00-05:00`);
const deps = (now = NOW) => ({ now, baseUrl: BASE_URL });
const codes = () => world.db.select().from(promoCodes).orderBy(asc(promoCodes.createdAt));
const byToken = (token: string) => ({ kind: "token", token }) as const;
/** A visit on each day, completed that evening. */
async function visitOn(days: string[]) {
  for (const date of days) {
    expectOk(await world.book({ date }));
    await completeVisits(world.db, evening(date), BASE_URL);
  }
}
/** A free hour the studio hands Jane, valid 30 days. */
async function handOut(note = "") {
  const made = await createManualCode(world.db, { kind: "free_hour", value: FREE_HOUR_MINUTES, email: JANE, validDays: 30, maxUses: 1, note }, NOW);
  if (!made.ok) throw new Error(made.message);
  return (await world.db.select().from(promoCodes).where(eq(promoCodes.code, made.code)))[0];
}

describe("a customer's rewards", () => {
  it("lists a reward earned by visits as Available, with its code, the day it was issued and the day it expires", async () => {
    await visitOn(DAYS);
    const rewards = await listRewards(world.db, JANE, evening(DAYS[4]));
    expect(rewards).toHaveLength(1);
    expect(rewards[0]).toMatchObject({
      name: "Free Studio Hour",
      status: "available",
      redeemed: null,
      source: "loyalty",
      issuedAt: evening(DAYS[4]).toISOString(),
      expiresAt: daysAfter(evening(DAYS[4]), 90).toISOString(),
    });
    expect(rewards[0].code).toMatch(/^THANKS-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    // It is the customer's first free hour, and the database knows it by that number.
    expect((await codes())[0]).toMatchObject({ loyaltySeq: 1 });
  });

  it("shows a used reward as Redeemed, with the date and the appointment, and it cannot be used again", async () => {
    const reward = await handOut();
    const booked = expectOk(await world.book({ date: FAR, durationMinutes: 60, promoCode: reward.code, paymentToken: undefined }));
    const [listed] = await listRewards(world.db, JANE, NOW);
    expect(listed).toMatchObject({
      status: "redeemed",
      redeemed: { at: NOW.toISOString(), bookingRef: booked.ref, visitAt: "2026-12-09T15:00:00.000Z" },
    });
    expect(await world.book({ date: "2026-12-10", durationMinutes: 60, promoCode: reward.code, paymentToken: undefined })).toMatchObject({
      ok: false,
      code: "invalid_code",
      message: "That code has already been used.",
    });
  });

  it("makes a reward Available again when the booking it paid for is cancelled", async () => {
    const reward = await handOut();
    const booked = expectOk(await world.book({ date: FAR, durationMinutes: 60, promoCode: reward.code, paymentToken: undefined }));
    expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    expect((await listRewards(world.db, JANE, NOW))[0]).toMatchObject({ status: "available", redeemed: null });
  });

  it("shows a reward past its date as Expired, and keeps it in the history", async () => {
    await handOut();
    expect((await listRewards(world.db, JANE, daysAfter(NOW, 29)))[0].status).toBe("available");
    expect((await listRewards(world.db, JANE, daysAfter(NOW, 30)))[0].status).toBe("expired");
    expect(await listRewards(world.db, JANE, daysAfter(NOW, 400))).toHaveLength(1);
  });

  it("lists every reward, newest first, and only the customer's own free hours", async () => {
    const first = await handOut("Regular since 2024");
    await world.db.update(promoCodes).set({ createdAt: daysAfter(NOW, -10) }).where(eq(promoCodes.id, first.id));
    const second = await handOut();
    // Neither a discount code, nor credit, nor someone else's free hour is a reward of Jane's.
    await createManualCode(world.db, { kind: "percent", value: 10, email: JANE, validDays: 30, maxUses: 1, note: "" }, NOW);
    await createManualCode(world.db, { kind: "amount", value: 5000, email: JANE, validDays: 30, maxUses: 1, note: "" }, NOW);
    await createManualCode(world.db, { kind: "free_hour", value: 60, email: "bob@example.com", validDays: 30, maxUses: 1, note: "" }, NOW);

    const rewards = await listRewards(world.db, " Jane@Example.com ", NOW);
    expect(rewards.map((reward) => reward.code)).toEqual([second.code, first.code]);
    expect(rewards[1]).toMatchObject({ source: "manual", note: "Regular since 2024" });
    expect(await listRewards(world.db, "nobody@example.com", NOW)).toEqual([]);
  });

  it("is always one use: a free hour handed out for several uses is still used once", async () => {
    const made = await createManualCode(world.db, { kind: "free_hour", value: 60, email: JANE, validDays: 30, maxUses: 5, note: "" }, NOW);
    expect(made.ok).toBe(true);
    expect((await codes())[0].maxUses).toBe(1);
  });
});

describe("an owner cancels a reward, and gives it back", () => {
  it("shows it as Canceled, refuses it at checkout, and records who cancelled it and why", async () => {
    const reward = await handOut();
    expect(await cancelReward(world.db, owner, reward.id, "Given to the wrong customer", NOW)).toEqual({ ok: true, code: reward.code });
    expect((await listRewards(world.db, JANE, NOW))[0].status).toBe("cancelled");
    expect(await world.book({ date: FAR, durationMinutes: 60, promoCode: reward.code, paymentToken: undefined })).toMatchObject({
      ok: false,
      message: "That code is not valid.",
    });
    expect(await listRewardChanges(world.db, JANE)).toEqual([
      { at: NOW.toISOString(), kind: "reward_cancelled", code: reward.code, reason: "Given to the wrong customer", actor: "owner@studio.test" },
    ]);

    // Given back: usable again, until the date it always had.
    const later = minutesAfter(NOW, 10);
    expect(await restoreReward(world.db, owner, reward.id, "It was the right customer after all", later)).toEqual({ ok: true, code: reward.code });
    expect((await listRewards(world.db, JANE, later))[0]).toMatchObject({ status: "available", expiresAt: daysAfter(NOW, 30).toISOString() });
    expect((await world.book({ date: FAR, durationMinutes: 60, promoCode: reward.code, paymentToken: undefined })).ok).toBe(true);
    expect((await listRewardChanges(world.db, JANE)).map((change) => change.kind)).toEqual(["reward_restored", "reward_cancelled"]);
  });

  it("needs a reason, and an owner", async () => {
    const reward = await handOut();
    expect(await cancelReward(world.db, owner, reward.id, "  ", NOW)).toMatchObject({ ok: false });
    expect(await cancelReward(world.db, owner, reward.id, "x", NOW)).toMatchObject({ ok: false });
    expect(await cancelReward(world.db, sam, reward.id, "Not mine to cancel", NOW)).toEqual({ ok: false, message: "You cannot cancel a reward." });
    expect(await cancelReward(world.db, jane, reward.id, "Not mine to cancel", NOW)).toMatchObject({ ok: false });
    expect(await restoreReward(world.db, sam, reward.id, "Not mine to give back", NOW)).toMatchObject({ ok: false });
    expect((await listRewards(world.db, JANE, NOW))[0].status).toBe("available");
    expect(await world.db.select().from(loyaltyLedger)).toHaveLength(0);
  });

  it("does not cancel a reward that was used, cancel twice, or give back one that is not cancelled", async () => {
    const used = await handOut();
    expectOk(await world.book({ date: FAR, durationMinutes: 60, promoCode: used.code, paymentToken: undefined }));
    expect(await cancelReward(world.db, owner, used.id, "Too late for that", NOW)).toEqual({
      ok: false,
      message: "That reward was already used, so there is nothing left to cancel.",
    });

    const spare = await handOut();
    expect(await restoreReward(world.db, owner, spare.id, "Nothing to give back", NOW)).toEqual({ ok: false, message: "That reward is not cancelled." });
    expectOk(await cancelReward(world.db, owner, spare.id, "A mistake", NOW));
    expect(await cancelReward(world.db, owner, spare.id, "A mistake", NOW)).toEqual({ ok: false, message: "That reward is already cancelled." });
    expect(await cancelReward(world.db, owner, "not-an-id", "A mistake", NOW)).toEqual({ ok: false, message: "That reward was not found." });
    // A discount code is not a reward.
    await createManualCode(world.db, { kind: "percent", value: 10, email: JANE, validDays: 30, maxUses: 1, note: "" }, NOW);
    const discount = (await codes()).find((code) => code.kind === "percent")!;
    expect(await cancelReward(world.db, owner, discount.id, "Not a reward", NOW)).toEqual({ ok: false, message: "That reward was not found." });
  });

  it("is recorded the same way when a reward is cancelled on the Codes page", async () => {
    const reward = await handOut();
    await voidCode(world.db, reward.id, NOW, "owner@studio.test");
    await voidCode(world.db, reward.id, minutesAfter(NOW, 1), "owner@studio.test"); // pressed twice: one line
    expect(await listRewardChanges(world.db, JANE)).toEqual([
      { at: NOW.toISOString(), kind: "reward_cancelled", code: reward.code, reason: "Cancelled on the Codes page", actor: "owner@studio.test" },
    ]);
  });
});

describe("an owner corrects a customer's stamps", () => {
  const standing = () => loyaltyStandingOf(world.db, JANE, DEFAULT_SETTINGS);

  it("adds stamps for visits the site never counted, with a reason, without touching the visits", async () => {
    await visitOn(DAYS.slice(0, 2));
    const result = expectOk(await adjustStamps(world.db, owner, { email: JANE, stamps: 2, reason: "Two visits in October, before the new site" }, deps()));
    expect(result).toMatchObject({ sent: 0, standing: { stamps: 4, adjustment: 2, towardsNext: 4, needed: 1 } });
    expect((await standing()).days.map((entry) => entry.day)).toEqual(DAYS.slice(0, 2)); // the visits are as they were
    expect(await listStampChanges(world.db, JANE)).toEqual([
      { at: NOW.toISOString(), stamps: 2, reason: "Two visits in October, before the new site", actor: "owner@studio.test" },
    ]);
  });

  it("sends the free hour at once when the added stamps complete five", async () => {
    await visitOn(DAYS.slice(0, 3));
    const at = evening(DAYS[2]);
    const result = expectOk(await adjustStamps(world.db, owner, { email: JANE, stamps: 2, reason: "Two visits before the site" }, deps(at)));
    expect(result).toMatchObject({ sent: 1, standing: { stamps: 5, earned: 1, towardsNext: 0 } });
    const [reward] = await listRewards(world.db, JANE, at);
    expect(reward).toMatchObject({ status: "available", source: "loyalty", expiresAt: daysAfter(at, 90).toISOString() });
    const [mail] = await world.emails("loyalty_code");
    expect(mail.toEmail).toBe(JANE);
    expect(mail.body).toContain(`Code: ${reward.code}`);

    // The next visits do not send that free hour a second time: it is this customer's first, and exists once.
    await visitOn(DAYS.slice(3));
    expect(await codes()).toHaveLength(1);
    expect(await standing()).toMatchObject({ stamps: 7, earned: 1, towardsNext: 2 });
  });

  it("sends each free hour once when many stamps are added, also to someone who never booked here", async () => {
    const result = expectOk(await adjustStamps(world.db, owner, { email: "New.Regular@Example.com", stamps: 12, reason: "Twelve visits on the old system" }, deps()));
    expect(result).toMatchObject({ sent: 2, standing: { stamps: 12, earned: 2, towardsNext: 2 } });
    const sent = await codes();
    expect(sent.map((code) => [code.email, code.loyaltySeq, code.originBookingId])).toEqual([
      ["new.regular@example.com", 1, null],
      ["new.regular@example.com", 2, null],
    ]);
    expect((await world.emails("loyalty_code"))[0].body).toContain("Hi there,");
    // Asked again by the scheduled task, or by two requests at once: nothing more is owed.
    expect((await adjustStamps(world.db, owner, { email: "new.regular@example.com", stamps: 1, reason: "One more" }, deps())).ok).toBe(true);
    expect(await codes()).toHaveLength(2);
  });

  it("takes stamps away, never below nothing, and a free hour already sent stays sent", async () => {
    await visitOn(DAYS);
    expect(await codes()).toHaveLength(1);
    const result = expectOk(await adjustStamps(world.db, owner, { email: JANE, stamps: -2, reason: "Two visits were another client's" }, deps()));
    expect(result).toMatchObject({ sent: 0, standing: { stamps: 3, earned: 0, towardsNext: 3 } });
    expect(await adjustStamps(world.db, owner, { email: JANE, stamps: -4, reason: "Too many" }, deps())).toEqual({
      ok: false,
      message: "This customer has 3 stamps: no more than that can be taken away.",
    });
    // Two more visits bring her back to five: that free hour was already sent, so nothing new goes out.
    await visitOn(["2026-11-25", "2026-11-27"]);
    expect(await standing()).toMatchObject({ stamps: 5, earned: 1 });
    expect(await codes()).toHaveLength(1);
  });

  it("refuses a change without a reason, a number that makes no sense, and anyone who is not an owner", async () => {
    const ask = (viewer: AuthUser, stamps: number, reason = "A good reason", email = JANE) => adjustStamps(world.db, viewer, { email, stamps, reason }, deps());
    expect(await ask(owner, 1, "")).toMatchObject({ ok: false });
    expect(await ask(owner, 0)).toMatchObject({ ok: false });
    expect(await ask(owner, 1.5)).toMatchObject({ ok: false });
    expect(await ask(owner, 51)).toMatchObject({ ok: false });
    expect(await ask(owner, 1, "A good reason", "not an address")).toEqual({ ok: false, message: "That is not a valid email address." });
    expect(await ask(sam, 1)).toEqual({ ok: false, message: "You cannot change stamps." });
    expect(await ask(jane, 5)).toMatchObject({ ok: false });
    expect(await world.db.select().from(loyaltyLedger)).toHaveLength(0);
    expect(await standing()).toMatchObject({ stamps: 0 });
  });

  it("can be a manager's to do once the owners switch it on, never an attendant's, and says who did it", async () => {
    const mia = await world.addUser("mia@studio.test", "manager", "Mia");
    const reward = await handOut();
    const ask = (viewer: AuthUser) => adjustStamps(world.db, viewer, { email: JANE, stamps: 1, reason: "A visit before the site" }, deps());
    // Off by default for managers: a client's rewards are money's worth.
    expect(await ask(mia)).toEqual({ ok: false, message: "You cannot change stamps." });
    expect(await cancelReward(world.db, mia, reward.id, "Not allowed yet", NOW)).toMatchObject({ ok: false });

    await world.db.insert(settings).values({ key: "managerCorrectsLoyalty", value: true });
    expect((await ask(mia)).ok).toBe(true);
    expectOk(await cancelReward(world.db, mia, reward.id, "Handed out twice", NOW));
    expectOk(await restoreReward(world.db, mia, reward.id, "It was right after all", NOW));
    expect((await listStampChanges(world.db, JANE))[0].actor).toBe("mia@studio.test");
    expect((await listRewardChanges(world.db, JANE)).map((change) => change.actor)).toEqual(["mia@studio.test", "mia@studio.test"]);
    // No switch gives this to an attendant.
    expect(await ask(sam)).toMatchObject({ ok: false });
  });

  it("sends nothing while loyalty is switched off", async () => {
    await world.db.insert(settings).values({ key: "loyaltyEnabled", value: false });
    const result = expectOk(await adjustStamps(world.db, owner, { email: JANE, stamps: 5, reason: "Five visits before the site" }, deps()));
    expect(result).toMatchObject({ sent: 0, standing: { stamps: 5, earned: 1 } });
    expect(await codes()).toHaveLength(0);
  });

  it("keeps a stamp from being counted twice for one visit: a day is one stamp, whatever is added by hand", async () => {
    expectOk(await world.book({ date: DAYS[0] }));
    expectOk(await world.book({ date: DAYS[0], studioIds: [world.ids.paris], startMinute: 14 * 60 }));
    await completeVisits(world.db, evening(DAYS[0]), BASE_URL);
    expect(await standing()).toMatchObject({ stamps: 1 });
    expectOk(await adjustStamps(world.db, owner, { email: JANE, stamps: 1, reason: "A visit before the site" }, deps()));
    expect(await standing()).toMatchObject({ stamps: 2, days: [{ day: DAYS[0] }] });
    expect((await world.db.select().from(bookings)).length).toBe(2);
  });
});
