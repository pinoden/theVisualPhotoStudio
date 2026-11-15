import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookings, promoCodes, settings } from "@/db/schema";
import { createManualCode } from "./admin";
import { createAdminBooking } from "./appointments";
import type { AuthUser } from "./auth";
import { getCustomer, listCustomers } from "./customers";
import { FREE_HOUR_MINUTES } from "./loyalty";
import { cancelBooking, requestRescheduleCode } from "./manage";
import { adjustStamps, cancelReward } from "./rewards";
import { completeVisits } from "./tasks";
import { BASE_URL, createTestWorld, expectOk, FAR, h, NEAR, NOW, type TestWorld } from "./testing";

/**
 * The owner's client portal, "Admin Controls & Data Security": administrators
 * see each customer's bookings, payments and receipts, stamps and reward
 * codes, and whether a reward was redeemed; and nobody else sees any of it.
 */
let world: TestWorld;
let owner: AuthUser;
let sam: AuthUser; // staff
let jane: AuthUser; // a customer with an account

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
const bob = { name: "Bob Brown", email: "bob@example.com", phone: "407-555-0111" };
const byToken = (token: string) => ({ kind: "token", token }) as const;
const AFTER = new Date("2026-11-19T04:00:00Z"); // the evening of NEAR

describe("the list of customers", () => {
  it("has one line for each person who booked, with their latest name and phone, newest booking first", async () => {
    expectOk(await world.book({ customer: { name: "Jane S.", email: JANE, phone: "407-555-0100" } }));
    expectOk(await world.book({ date: FAR, studioIds: [world.ids.paris], durationMinutes: 60, customer: bob }));
    // Jane books again, later, under her full name and a new number.
    await world.db.update(bookings).set({ createdAt: new Date("2026-11-13T15:00:00Z") });
    expectOk(await world.book({ date: "2026-12-10", customer: { name: "Jane Smith", email: JANE, phone: "407-555-0199" } }));

    const customers = (await listCustomers(world.db, owner, { now: NOW }))!;
    expect(customers.map((customer) => customer.email)).toEqual([JANE, "bob@example.com"]);
    expect(customers[0]).toMatchObject({
      name: "Jane Smith",
      phone: "407-555-0199",
      bookings: 2,
      lastVisit: null,
      nextVisit: "2026-11-18T15:00:00.000Z",
      hasAccount: true,
    });
    expect(customers[1]).toMatchObject({ name: "Bob Brown", bookings: 1, hasAccount: false });
  });

  it("says when someone last visited, and does not count a cancelled booking or an abandoned checkout", async () => {
    expectOk(await world.book());
    const cancelled = expectOk(await world.book({ date: FAR }));
    expectOk(await cancelBooking(world.db, cancelled.ref, byToken(cancelled.manageToken), world.manageDeps()));
    expect(await world.book({ date: "2026-12-10", paymentToken: "mock-card-declined", customer: bob })).toMatchObject({ ok: false });
    await completeVisits(world.db, AFTER, BASE_URL);

    const customers = (await listCustomers(world.db, owner, { now: AFTER }))!;
    expect(customers).toHaveLength(1); // Bob's card was refused: he is not a customer
    expect(customers[0]).toMatchObject({ bookings: 1, lastVisit: "2026-11-18T15:00:00.000Z", nextVisit: null });
  });

  it("is searched by a part of the name or the email, whatever the capitals, and treats % and _ as letters", async () => {
    expectOk(await world.book());
    expectOk(await world.book({ date: FAR, customer: bob }));
    expectOk(await world.book({ date: "2026-12-10", customer: { name: "100% Photo_Co", email: "studio_x@example.com", phone: "407-555-0122" } }));
    const found = async (q: string) => (await listCustomers(world.db, owner, { q, now: NOW }))!.map((customer) => customer.email);
    expect(await found("BROWN")).toEqual(["bob@example.com"]);
    expect(await found("jane@")).toEqual([JANE]);
    expect(await found("  smith ")).toEqual([JANE]);
    expect(await found("example.com")).toHaveLength(3);
    expect(await found("%")).toEqual(["studio_x@example.com"]);
    expect(await found("_x")).toEqual(["studio_x@example.com"]);
    expect(await found("nobody")).toEqual([]);
    expect(await found("'; drop table bookings; --")).toEqual([]);
    expect(await found("")).toHaveLength(3);
  });

  it("is the owners' alone", async () => {
    expectOk(await world.book());
    expect(await listCustomers(world.db, sam, { now: NOW })).toBeNull();
    expect(await listCustomers(world.db, jane, { now: NOW })).toBeNull();
  });
});

describe("one customer's page", () => {
  it("has their appointments, what they paid, their stamps, their rewards and their credit", async () => {
    const visited = expectOk(await world.book());
    const upcoming = expectOk(await world.book({ date: FAR, studioIds: [world.ids.paris], durationMinutes: 60 }));
    const moved = expectOk(await world.book({ date: "2026-12-10" }));
    const credit = expectOk(await requestRescheduleCode(world.db, moved.ref, byToken(moved.manageToken), world.manageDeps()));
    await completeVisits(world.db, AFTER, BASE_URL);
    const made = await createManualCode(world.db, { kind: "free_hour", value: FREE_HOUR_MINUTES, email: JANE, validDays: 30, maxUses: 1, note: "Welcome back" }, NOW);
    expectOk(await adjustStamps(world.db, owner, { email: JANE, stamps: 2, reason: "Two visits before the site" }, { now: AFTER, baseUrl: BASE_URL }));

    const page = (await getCustomer(world.db, owner, " Jane@Example.com ", AFTER))!;
    expect(page).toMatchObject({ email: JANE, name: "Jane Smith", phone: "407-555-0100", hasAccount: true, perReward: 5 });
    expect(page.upcoming.map((booking) => booking.ref)).toEqual([upcoming.ref]);
    expect(page.past.map((booking) => booking.ref)).toEqual([moved.ref, visited.ref]);
    expect(page.standing).toMatchObject({ stamps: 3, adjustment: 2, towardsNext: 3, days: [{ day: NEAR }] });
    expect(page.stampChanges).toMatchObject([{ stamps: 2, reason: "Two visits before the site", actor: "owner@studio.test" }]);
    expect(page.rewards).toMatchObject([{ code: made.ok ? made.code : "", status: "available", source: "manual", note: "Welcome back" }]);
    expect(page.codes).toMatchObject([{ code: credit.code, kind: "amount", value: 17600, source: "reschedule", state: "available" }]);
    // Three payments, three receipts, and nothing waiting to be paid.
    expect(page.receipts.map((receipt) => [receipt.ref, receipt.paidCents]).sort()).toEqual(
      [
        [visited.ref, 17600],
        [upcoming.ref, 6800],
        [moved.ref, 17600],
      ].sort(),
    );
    expect(page.unpaid).toEqual([]);
  });

  it("shows whether a reward was redeemed, and for which appointment; and what happened to a code", async () => {
    const made = await createManualCode(world.db, { kind: "free_hour", value: FREE_HOUR_MINUTES, email: JANE, validDays: 30, maxUses: 1, note: "" }, NOW);
    const code = made.ok ? made.code : "";
    const booked = expectOk(await world.book({ date: FAR, durationMinutes: 60, promoCode: code, paymentToken: undefined }));
    const spare = await createManualCode(world.db, { kind: "free_hour", value: FREE_HOUR_MINUTES, email: JANE, validDays: 30, maxUses: 1, note: "" }, NOW);
    const [spareRow] = await world.db.select().from(promoCodes).where(eq(promoCodes.code, spare.ok ? spare.code : ""));
    expectOk(await cancelReward(world.db, owner, spareRow.id, "Handed out twice by mistake", NOW));
    await createManualCode(world.db, { kind: "percent", value: 10, email: JANE, validDays: 1, maxUses: 1, note: "" }, NOW);

    const later = new Date("2026-11-20T15:00:00Z");
    const page = (await getCustomer(world.db, owner, JANE, later))!;
    expect(page.rewards.find((reward) => reward.code === code)).toMatchObject({ status: "redeemed", redeemed: { bookingRef: booked.ref } });
    expect(page.rewards.find((reward) => reward.id === spareRow.id)).toMatchObject({ status: "cancelled" });
    expect(page.rewardChanges).toMatchObject([{ kind: "reward_cancelled", reason: "Handed out twice by mistake", actor: "owner@studio.test" }]);
    expect(page.codes).toMatchObject([{ kind: "percent", value: 10, state: "expired" }]);
  });

  it("lists what a booking made in the admin still owes, apart from the receipts", async () => {
    const made = expectOk(
      await createAdminBooking(
        world.db,
        owner,
        { studioIds: [world.ids.paris], date: NEAR, startMinute: h(14), durationMinutes: 60, customer: bob },
        { now: NOW, baseUrl: BASE_URL },
      ),
    );
    const page = (await getCustomer(world.db, owner, bob.email, NOW))!;
    expect(page).toMatchObject({ name: "Bob Brown", phone: "407-555-0111", hasAccount: false, receipts: [] });
    expect(page.unpaid).toEqual([{ ref: made.ref, visitStart: "2026-11-18T19:00:00.000Z", studios: "Studio Paris", dueCents: 6800 }]);
  });

  it("opens for an address with nothing recorded, so that stamps can be given to someone who never booked here", async () => {
    const page = (await getCustomer(world.db, owner, "new.regular@example.com", NOW))!;
    expect(page).toMatchObject({ email: "new.regular@example.com", name: "", phone: "", hasAccount: false, upcoming: [], past: [], rewards: [], receipts: [] });
    expect(page.standing).toMatchObject({ stamps: 0 });
    expect(await getCustomer(world.db, owner, "not an address", NOW)).toBeNull();
  });

  it("is the owners' alone: staff and customers get nothing, also for their own address", async () => {
    expectOk(await world.book());
    expect(await getCustomer(world.db, sam, JANE, NOW)).toBeNull();
    expect(await getCustomer(world.db, jane, JANE, NOW)).toBeNull();
    // A member of staff with every ability the owners can switch on still cannot.
    for (const key of ["staffSeesContact", "staffSeesPrices", "staffSeesAllDays", "staffRecordsPayments"]) {
      await world.db.insert(settings).values({ key, value: true }).onConflictDoUpdate({ target: settings.key, set: { value: true } });
    }
    expect(await getCustomer(world.db, sam, JANE, NOW)).toBeNull();
    expect(await listCustomers(world.db, sam, { now: NOW })).toBeNull();
  });

  it("says nothing about stamps while loyalty is switched off", async () => {
    await world.db.insert(settings).values({ key: "loyaltyEnabled", value: false });
    expect((await getCustomer(world.db, owner, JANE, NOW))!.standing).toBeNull();
  });
});

describe("a booking an administrator makes with the client's reward", () => {
  it("takes the free hour off what is paid at the studio, and uses the reward up", async () => {
    const made = await createManualCode(world.db, { kind: "free_hour", value: FREE_HOUR_MINUTES, email: bob.email, validDays: 30, maxUses: 1, note: "" }, NOW);
    const code = made.ok ? made.code : "";
    const booked = expectOk(
      await createAdminBooking(
        world.db,
        owner,
        { studioIds: [world.ids.blanche], date: NEAR, startMinute: h(14), durationMinutes: 120, customer: bob, promoCode: code },
        { now: NOW, baseUrl: BASE_URL },
      ),
    );
    expect(booked.totalCents).toBe(17600 - 8800); // two hours less the one-hour price
    const page = (await getCustomer(world.db, owner, bob.email, NOW))!;
    expect(page.rewards).toMatchObject([{ code, status: "redeemed", redeemed: { bookingRef: booked.ref } }]);
    expect(page.unpaid).toMatchObject([{ dueCents: 8800 }]);
    // Somebody else's reward is refused, as at checkout.
    expect(
      await createAdminBooking(
        world.db,
        owner,
        { studioIds: [world.ids.paris], date: NEAR, startMinute: h(9), durationMinutes: 60, customer: { ...bob, email: "eve@example.com" }, promoCode: code },
        { now: NOW, baseUrl: BASE_URL },
      ),
    ).toMatchObject({ ok: false, code: "invalid_code" });
  });
});
