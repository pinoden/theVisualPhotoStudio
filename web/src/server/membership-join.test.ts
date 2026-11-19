import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { membershipMinutes, membershipPayments, memberships } from "@/db/schema";
import { cancelMembership, joinMembership, listPlans, membershipPaymentsOf, membershipsOf, savePlan, setPlanActive, type JoinDeps, type PlanView } from "./memberships";
import { MOCK_TOKEN_DECLINED, MOCK_TOKEN_OK, monthsAfter, type PaymentProvider } from "./payments";
import { BASE_URL, createTestWorld, expectOk, NOW, OWNER_EMAIL, type TestWorld } from "./testing";

/** Follow-up 3, step 2 of the plan of 2026-11-18: buying a membership online. */
let world: TestWorld;
let paris5: PlanView;
let dayglow10: PlanView;
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  const plans = await listPlans(world.db);
  paris5 = plans.find((plan) => plan.name === "Studio Paris, 5 hours a month")!;
  dayglow10 = plans.find((plan) => plan.name === "Studio Dayglow, 10 hours a month")!;
});

const deps = (over: Partial<JoinDeps> = {}): JoinDeps => ({ now: NOW, payments: world.provider, baseUrl: BASE_URL, ownerEmail: OWNER_EMAIL, ...over });
const input = (over: Record<string, unknown> = {}) => ({
  planId: paris5.id,
  customer: { name: "Jane Smith", email: "Jane@Example.com", phone: "407-555-0100" },
  acceptTerms: true,
  paymentToken: MOCK_TOKEN_OK,
  requestId: randomUUID(),
  ...over,
});
const rowOf = async (id: string) => (await world.db.select().from(memberships).where(eq(memberships.id, id)))[0];

describe("buying a membership", () => {
  it("charges the first month, keeps the card, subscribes from the same day next month, adds the minutes and emails the code", async () => {
    const { membership } = expectOk(await joinMembership(world.db, input(), deps()));
    expect(membership).toMatchObject({
      email: "jane@example.com",
      planName: "Studio Paris, 5 hours a month",
      minutesPerMonth: 300,
      priceCents: 30000,
      status: "active",
      startedOn: "2026-11-14",
      nextBilling: "2026-12-14",
      endsOn: null,
      minutesLeft: 300,
    });
    expect(membership.code).toMatch(/^MEMBER-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);

    const row = await rowOf(membership.id);
    expect(world.charges).toEqual([expect.objectContaining({ amountCents: 30000, idempotencyKey: membership.id, reference: membership.code, customerId: row.customerId })]);
    expect(world.subscriptions).toEqual([
      expect.objectContaining({ id: row.subscriptionId, customerId: row.customerId, cardId: row.cardId, startDate: "2026-12-14", variationId: "price_1" }),
    ]);
    const payments = await world.db.select().from(membershipPayments).where(eq(membershipPayments.membershipId, membership.id));
    expect(payments).toEqual([expect.objectContaining({ processorId: `mock_${membership.id}`, amountCents: 30000, periodStart: "2026-11-14", refundedAt: null })]);
    const minutes = await world.db.select().from(membershipMinutes).where(eq(membershipMinutes.membershipId, membership.id));
    expect(minutes).toEqual([expect.objectContaining({ minutes: 300, kind: "month", paymentId: payments[0].id, note: "The first month", actor: "the site" })]);

    const [mail] = await world.emails("membership_started");
    expect(mail).toMatchObject({ toEmail: "jane@example.com", subject: "Your membership: Studio Paris, 5 hours a month" });
    expect(mail.body).toContain(`Your membership code: ${membership.code}`);
    expect(mail.body).toContain("Studio Paris, 5 hours a month: 5 hours of studio time each month, for $300 a month.");
    expect(mail.body).toContain("The next is billed to the same card on Monday, December 14, 2026");
    expect(mail.body).toContain(`${BASE_URL}/book and enter the code`);
    expect(mail.body).toContain(`${BASE_URL}/account/membership`);

    expect(await membershipsOf(world.db, " JANE@example.com ")).toEqual([membership]);
  });

  it("charges once however often it is pressed, and reuses the client's customer and the plan's price", async () => {
    const once = input();
    const first = expectOk(await joinMembership(world.db, once, deps()));
    const again = expectOk(await joinMembership(world.db, once, deps()));
    expect(again.membership.id).toBe(first.membership.id);
    expect(world.charges).toHaveLength(1);
    expect(await world.emails("membership_started")).toHaveLength(1);

    // The same client buys a second plan, and another client the first one.
    const second = expectOk(await joinMembership(world.db, input({ planId: dayglow10.id }), deps({ now: new Date(NOW.getTime() + 60_000) })));
    expectOk(await joinMembership(world.db, input({ customer: { name: "Bob Brown", email: "bob@example.com", phone: "407-555-0111" } }), deps()));
    const [a, b, c] = world.subscriptions;
    expect(b.customerId).toBe(a.customerId);
    expect(c.customerId).not.toBe(a.customerId);
    expect(c.variationId).toBe(a.variationId);
    expect(world.planPrices.size).toBe(2);
    expect(second.membership).toMatchObject({ minutesPerMonth: 600, priceCents: 60000, minutesLeft: 600 });
    expect((await membershipsOf(world.db, "jane@example.com")).map((view) => view.planName)).toEqual(["Studio Dayglow, 10 hours a month", "Studio Paris, 5 hours a month"]);
  });

  it("charges nothing when the owners changed the plan after the page showed it, and asks the client to look again (the tester's finding)", async () => {
    // The page showed $300 for 5 hours; an owner raises it to $350 before the client presses.
    const shown = { priceCents: paris5.priceCents, minutes: paris5.minutes };
    expect(await savePlan(world.db, paris5.id, { name: paris5.name, description: paris5.description, minutes: paris5.minutes, priceCents: 35000 })).toMatchObject({ ok: true });
    expect(await joinMembership(world.db, input({ expected: shown }), deps())).toEqual({
      ok: false,
      status: 409,
      code: "price_changed",
      message: "This membership has changed since the page was opened: it is now $350 a month for 5 hours of studio time. Nothing was charged. Please look at it again, and agree to the terms at that price.",
    });
    expect(world.charges).toEqual([]);
    expect(await world.db.select().from(memberships)).toEqual([]);
    // Agreed to at the new price, it is bought at that price.
    expect(expectOk(await joinMembership(world.db, input({ expected: { priceCents: 35000, minutes: paris5.minutes } }), deps())).membership).toMatchObject({ priceCents: 35000 });
    expect(world.charges.map((charge) => charge.amountCents)).toEqual([35000]);
  });

  it("buys one membership and charges once when pressed twice at the same moment (the tester's check)", async () => {
    const once = input();
    const [a, b] = await Promise.all([joinMembership(world.db, once, deps()), joinMembership(world.db, once, deps())]);
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(world.charges).toHaveLength(1);
    expect(world.subscriptions).toHaveLength(1);
    expect(await world.db.select().from(memberships)).toHaveLength(1);
    expect((await membershipsOf(world.db, "jane@example.com"))[0].minutesLeft).toBe(300);
  });

  it("starts nothing with a declined card, and a new attempt can buy it", async () => {
    const declined = input({ paymentToken: MOCK_TOKEN_DECLINED });
    expect(await joinMembership(world.db, declined, deps())).toEqual({ ok: false, status: 402, code: "declined", message: "Card declined." });
    expect(await joinMembership(world.db, declined, deps())).toMatchObject({ ok: false, code: "failed_before" });
    expect(await membershipsOf(world.db, "jane@example.com")).toEqual([]);
    expect(world.subscriptions).toHaveLength(0);
    expectOk(await joinMembership(world.db, input(), deps()));
    expect(await membershipsOf(world.db, "jane@example.com")).toHaveLength(1);
  });

  it("refunds the first month when the card cannot be kept or the subscription cannot be made", async () => {
    world.failMembership = { step: "card", message: "The card cannot be stored." };
    const refused = await joinMembership(world.db, input(), deps());
    expect(refused).toMatchObject({ ok: false, code: "not_set_up" });
    expect(refused.ok ? "" : refused.message).toContain("the first month was refunded to your card");
    expect(world.refundCalls).toEqual([expect.objectContaining({ amountCents: 30000, paymentId: world.charges[0] && `mock_${world.charges[0].idempotencyKey}` })]);

    world.failMembership = { step: "subscribe", message: "No subscriptions today." };
    expect(await joinMembership(world.db, input(), deps())).toMatchObject({ ok: false, code: "not_set_up" });
    expect(world.refundCalls).toHaveLength(2);
    const rows = await world.db.select().from(memberships);
    expect(rows.map((row) => row.status)).toEqual(["failed", "failed"]);
    expect(rows[1].problem).toBe("The monthly payments could not be set up: No subscriptions today.");
    const paid = await world.db.select().from(membershipPayments);
    expect(paid.every((payment) => payment.refundedAt !== null)).toBe(true);
    expect(await world.db.select().from(membershipMinutes)).toEqual([]);
    expect(await membershipsOf(world.db, "jane@example.com")).toEqual([]);
    expect(await world.emails("membership_started")).toEqual([]);
  });

  it("tells the studio when that refund does not go through either", async () => {
    world.failMembership = { step: "subscribe", message: "No subscriptions today." };
    world.failRefunds = "Refunds are down.";
    const refused = await joinMembership(world.db, input(), deps());
    expect(refused.ok ? "" : refused.message).toContain("The first month's refund did not go through either: the studio has been told");
    const [notice] = await world.emails("owner_membership_refund");
    expect(notice.toEmail).toBe(OWNER_EMAIL);
    expect(notice.subject).toMatch(/^ACTION NEEDED: refund the first month of membership MEMBER-/);
    expect(notice.body).toContain("Jane Smith (jane@example.com) paid $300 for the first month");
    expect(notice.body).toContain("Refunds are down.");
  });

  it("carries on where it stopped when the processor's answer was lost, and charges once", async () => {
    const charge = world.provider.charge;
    world.provider.charge = async () => ({ ok: false, unknown: true, message: "We could not reach the card processor." });
    const once = input();
    try {
      expect(await joinMembership(world.db, once, deps())).toMatchObject({ ok: false, code: "no_answer" });
    } finally {
      world.provider.charge = charge;
    }
    const { membership } = expectOk(await joinMembership(world.db, once, deps()));
    expect(membership.status).toBe("active");
    expect(world.charges).toHaveLength(1);
    expect(await world.db.select().from(memberships)).toHaveLength(1);
  });

  it("refuses a plan no longer offered, details that are not right, and buying with no card processor", async () => {
    expect(await joinMembership(world.db, input({ acceptTerms: false }), deps())).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await joinMembership(world.db, input({ customer: { name: "J", email: "not-an-email", phone: "1" } }), deps())).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await joinMembership(world.db, input(), deps({ payments: null }))).toMatchObject({ ok: false, code: "payments_unavailable" });
    await setPlanActive(world.db, paris5.id, false);
    expect(await joinMembership(world.db, input(), deps())).toMatchObject({ ok: false, code: "not_offered" });
    expect(world.charges).toHaveLength(0);
    expect(await world.db.select().from(memberships)).toEqual([]);
  });

  it("bills on the same day each month, or the month's last day when it is shorter", () => {
    expect(monthsAfter("2026-11-14", 1)).toBe("2026-12-14");
    expect(monthsAfter("2026-12-31", 1)).toBe("2027-01-31");
    expect(monthsAfter("2027-01-31", 1)).toBe("2027-02-28");
    expect(monthsAfter("2027-01-31", 2)).toBe("2027-03-31");
    expect(monthsAfter("2028-01-30", 1)).toBe("2028-02-29");
  });
});

describe("cancelling a membership", () => {
  const JANE = { email: "Jane@Example.com", role: "customer" };
  const cancelDeps = (over: { payments?: PaymentProvider | null } = {}) => ({ now: NOW, payments: world.provider, baseUrl: BASE_URL, ...over });

  it("stops the monthly payments, lets the month paid for run on, keeps the hours, and tells the member", async () => {
    const { membership } = expectOk(await joinMembership(world.db, input(), deps()));
    const cancelled = expectOk(await cancelMembership(world.db, JANE, membership.id, cancelDeps()));
    expect(cancelled.membership).toMatchObject({ status: "cancelled", nextBilling: null, endsOn: "2026-12-14", minutesLeft: 300 });
    expect(world.subscriptions[0].endsOn).toBe("2026-12-14");
    const [mail] = await world.emails("membership_cancelled");
    expect(mail).toMatchObject({ toEmail: "jane@example.com", subject: "Your membership is cancelled: Studio Paris, 5 hours a month" });
    expect(mail.body).toContain("The month you paid for runs until Monday, December 14, 2026.");
    expect(mail.body).toContain(`The hours left on your code ${membership.code} stay yours to use: 5 hours.`);
    expect((await rowOf(membership.id)).cancelledAt).toEqual(NOW);
    expect(await membershipPaymentsOf(world.db, membership.id)).toEqual([{ periodStart: "2026-11-14", amountCents: 30000, paidAt: NOW, refunded: false }]);

    // Again: nothing more happens.
    expectOk(await cancelMembership(world.db, JANE, membership.id, cancelDeps()));
    expect(await world.emails("membership_cancelled")).toHaveLength(1);
  });

  it("is for the member or an owner only, and changes nothing when the processor does not answer", async () => {
    const { membership } = expectOk(await joinMembership(world.db, input(), deps()));
    expect(await cancelMembership(world.db, { email: "bob@example.com", role: "customer" }, membership.id, cancelDeps())).toMatchObject({ ok: false, code: "not_found" });
    expect(await cancelMembership(world.db, JANE, "not-a-membership", cancelDeps())).toMatchObject({ ok: false, code: "not_found" });

    world.failMembership = { step: "cancel", message: "Square is down." };
    expect(await cancelMembership(world.db, JANE, membership.id, cancelDeps())).toMatchObject({ ok: false, code: "no_answer" });
    const other = { ...world.provider, name: "square-sandbox" } as PaymentProvider;
    expect(await cancelMembership(world.db, JANE, membership.id, cancelDeps({ payments: other }))).toMatchObject({ ok: false, code: "no_answer" });
    expect((await rowOf(membership.id)).status).toBe("active");

    world.failMembership = null;
    expect(await cancelMembership(world.db, { email: OWNER_EMAIL, role: "owner" }, membership.id, cancelDeps())).toMatchObject({ ok: true, membership: { status: "cancelled" } });
  });

  it("is not offered for one that never started", async () => {
    const declined = input({ paymentToken: MOCK_TOKEN_DECLINED });
    await joinMembership(world.db, declined, deps());
    const [failed] = await world.db.select().from(memberships);
    expect(await cancelMembership(world.db, JANE, failed.id, cancelDeps())).toMatchObject({ ok: false, code: "not_found" });
  });
});

