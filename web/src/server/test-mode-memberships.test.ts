import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookings, membershipMinutes, membershipPayments, membershipPlanPrices, membershipPlans, memberships, payments } from "@/db/schema";
import { queueEmail } from "./email";
import { joinMembership, listPlans, membershipsOf } from "./memberships";
import { MOCK_TOKEN_OK, type PaymentProvider } from "./payments";
import {
  assertOneKindOfMoney,
  clearTestMode,
  describeTestMode,
  LIVE_ON_TEST,
  nothingOfTestMode,
  otherMoneyNotice,
  TEST_ON_LIVE,
  testModeContents,
} from "./test-mode";
import { BASE_URL, createTestWorld, expectOk, FAR, h, NOW, OWNER_EMAIL, type TestWorld } from "./testing";

/** Memberships bought in test mode (follow-up 3) are test money: the clear of test mode removes them, as it does bookings. */
let world: TestWorld;
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(() => world.reset());

const live = (): PaymentProvider => ({ ...world.provider, name: "square" });

async function join(email: string, name: string, payments: PaymentProvider = world.provider) {
  const plan = (await listPlans(world.db)).find((candidate) => candidate.name === "Studio Paris, 5 hours a month")!;
  return expectOk(
    await joinMembership(
      world.db,
      { planId: plan.id, customer: { name, email, phone: "407-555-0100" }, acceptTerms: true, paymentToken: MOCK_TOKEN_OK, requestId: randomUUID() },
      { now: NOW, payments, baseUrl: BASE_URL, ownerEmail: OWNER_EMAIL },
    ),
  );
}

describe("memberships bought in test mode", () => {
  it("go with their months, their hours, the bookings they paid for and the mail about them", async () => {
    const jane = await join("jane@example.com", "Jane Smith");
    expectOk(await world.book({ studioIds: [world.ids.paris], date: FAR, promoCode: jane.membership.code, paymentToken: undefined }));
    await expect(assertOneKindOfMoney(world.db, "square")).rejects.toThrow(LIVE_ON_TEST);
    expect(await otherMoneyNotice(world.db, "square")).toContain("It left 1 booking made in test mode, and 1 membership bought in test mode: none of it is real money.");

    const contents = await testModeContents(world.db, NOW);
    expect(contents).toMatchObject({
      bookings: 1,
      memberships: [{ code: jane.membership.code, customer: "Jane Smith", planName: "Studio Paris, 5 hours a month", status: "active", sandbox: false }],
      keptMemberships: [],
    });
    expect(describeTestMode(contents).join("\n")).toContain("Removed: 1 membership bought in test mode, with its months paid and hours.");
    const plans = await world.db.select().from(membershipPlans);

    // Before, the booking's line of hours kept it, and the clear failed.
    const cleared = await clearTestMode(world.db, NOW);
    expect(cleared.memberships.map((member) => member.code)).toEqual([jane.membership.code]);
    for (const table of [memberships, membershipPayments, membershipMinutes, membershipPlanPrices, bookings]) expect(await world.db.select().from(table)).toEqual([]);
    expect(await world.emails("membership_started")).toEqual([]);
    expect(await world.emails("booking_confirmation")).toEqual([]);
    await expect(assertOneKindOfMoney(world.db, "square")).resolves.toBeUndefined();
    // The plans are the owners': they stay.
    expect(await world.db.select().from(membershipPlans)).toEqual(plans);
  });

  it("are test money on their own: the live account refuses a database that holds one until it is cleared", async () => {
    await join("jane@example.com", "Jane Smith");
    await expect(assertOneKindOfMoney(world.db, "square")).rejects.toThrow(LIVE_ON_TEST);
    expect(await otherMoneyNotice(world.db, "square")).toContain("It left 1 membership bought in test mode: none of it is real money.");
    expect(nothingOfTestMode(await testModeContents(world.db, NOW))).toBe(false);
    await clearTestMode(world.db, NOW);
    await expect(assertOneKindOfMoney(world.db, "square")).resolves.toBeUndefined();
    expect(nothingOfTestMode(await testModeContents(world.db, NOW))).toBe(true);
  });

  it("leave a real membership and its member's mail: test mode refuses a database that holds one", async () => {
    const bob = await join("bob@example.com", "Bob Brown", live());
    const jane = await join("jane@example.com", "Jane Smith");
    // The owners' wording of an email to a member may leave its code out: it is told by the member's address.
    for (const to of ["jane@example.com", "bob@example.com"]) {
      await queueEmail(world.db, { to, kind: "membership_payment_problem", subject: "Your membership: a payment did not go through", body: "Please look at your card." });
    }
    await expect(assertOneKindOfMoney(world.db, "mock")).rejects.toThrow(TEST_ON_LIVE);
    expect(await otherMoneyNotice(world.db, "mock")).toContain("1 real membership is in this database");

    const cleared = await clearTestMode(world.db, NOW);
    expect(cleared.memberships.map((member) => member.code)).toEqual([jane.membership.code]);
    expect(await world.db.select({ code: memberships.code }).from(memberships)).toEqual([{ code: bob.membership.code }]);
    expect((await world.emails("membership_payment_problem")).map((mail) => mail.toEmail)).toEqual(["bob@example.com"]);
    expect((await world.emails("membership_started")).map((mail) => mail.toEmail)).toEqual(["bob@example.com"]);
    expect(await world.db.select({ provider: membershipPlanPrices.provider }).from(membershipPlanPrices)).toEqual([{ provider: "square" }]);
    expect((await membershipsOf(world.db, "bob@example.com"))[0]).toMatchObject({ minutesLeft: 300 });
  });

  it("keep one that pays for a booking counted as real from now on, which gets back what a removed booking took", async () => {
    const jane = await join("jane@example.com", "Jane Smith");
    const book = (startMinute: number, durationMinutes: number) =>
      world.book({ studioIds: [world.ids.paris], date: FAR, startMinute, durationMinutes, promoCode: jane.membership.code, paymentToken: undefined });
    const madeReal = expectOk(await book(h(10), 120));
    expectOk(await book(h(14), 60));
    expect((await membershipsOf(world.db, "jane@example.com"))[0].minutesLeft).toBe(120);
    // Square's live account took money for the first: it stays, and is real from now on.
    const [row] = await world.db.select().from(bookings).where(eq(bookings.ref, madeReal.ref));
    await world.db.insert(payments).values({ bookingId: row.id, provider: "square", providerPaymentId: "live-payment", amountCents: 800, status: "succeeded" });

    const cleared = await clearTestMode(world.db, NOW);
    expect(cleared).toMatchObject({ bookings: 1, memberships: [], keptMemberships: [{ code: jane.membership.code, customer: "Jane Smith" }] });
    expect(describeTestMode(cleared).join("\n")).toContain(
      `Kept: 1 membership bought in test mode that pays for a booking counted as real from now on. Look at it under Memberships:\n    ${jane.membership.code}, Jane Smith`,
    );
    expect(await world.db.select({ ref: bookings.ref }).from(bookings)).toEqual([{ ref: madeReal.ref }]);
    // The removed booking's hour comes back.
    expect((await membershipsOf(world.db, "jane@example.com"))[0].minutesLeft).toBe(180);
  });
});
