import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { membershipMinutes, membershipPayments, memberships } from "@/db/schema";
import { cancelMembership, joinMembership, listPlans, membershipsOf, runMembershipBilling, type JoinDeps } from "./memberships";
import { MOCK_TOKEN_OK, type PaymentProvider } from "./payments";
import { BASE_URL, createTestWorld, expectOk, NOW, OWNER_EMAIL, type TestWorld } from "./testing";

/** Follow-up 3, step 4 of the plan of 2026-11-18: each month of a membership. */
let world: TestWorld;
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(() => world.reset());

/** A moment on the studio's clock, in winter (UTC-5). */
const at = (day: string, hour = 10, minute = 0) => new Date(`${day}T${String(hour + 5).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
const deps = (now: Date, payments: PaymentProvider = world.provider): JoinDeps => ({ now, payments, baseUrl: BASE_URL, ownerEmail: OWNER_EMAIL });
const bill = (now: Date, payments?: PaymentProvider) => runMembershipBilling(world.db, deps(now, payments));

/** Jane joins Paris, 5 hours a month, on 2026-11-14: the subscription bills from 2026-12-14. */
async function join(email = "jane@example.com") {
  const plan = (await listPlans(world.db)).find((candidate) => candidate.name === "Studio Paris, 5 hours a month")!;
  const joined = await joinMembership(
    world.db,
    { planId: plan.id, customer: { name: "Jane Smith", email, phone: "407-555-0100" }, acceptTerms: true, paymentToken: MOCK_TOKEN_OK, requestId: randomUUID() },
    deps(NOW),
  );
  if (!joined.ok) throw new Error(joined.message);
  const [row] = await world.db.select().from(memberships).where(eq(memberships.id, joined.membership.id));
  return row;
}
const rowOf = async (id: string) => (await world.db.select().from(memberships).where(eq(memberships.id, id)))[0];
const monthsOf = async (id: string) => world.db.select().from(membershipPayments).where(eq(membershipPayments.membershipId, id));

describe("each month of a membership", () => {
  it("records each month Square was paid, once, with its minutes and an email to the member", async () => {
    const row = await join();
    expect(await bill(at("2026-11-20"))).toEqual({ monthsPaid: 0, problems: 0, carriedOn: 0 });
    // The day comes, before Square has billed.
    expect(await bill(at("2026-12-14", 8))).toEqual({ monthsPaid: 0, problems: 0, carriedOn: 0 });
    world.billMonth(row.subscriptionId!);
    // Asked again within the hour: not yet.
    expect(await bill(at("2026-12-14", 8, 30))).toMatchObject({ monthsPaid: 0 });
    expect(await bill(at("2026-12-14", 9, 5))).toMatchObject({ monthsPaid: 1, problems: 0 });

    const [view] = await membershipsOf(world.db, "jane@example.com");
    expect(view).toMatchObject({ minutesLeft: 600, nextBilling: "2027-01-14", status: "active" });
    const payments = await world.db.select().from(membershipPayments).where(eq(membershipPayments.membershipId, row.id));
    expect(payments.map((payment) => [payment.periodStart, payment.amountCents])).toEqual([
      ["2026-11-14", 30000],
      ["2026-12-14", 30000],
    ]);
    const lines = await world.db.select().from(membershipMinutes).where(eq(membershipMinutes.membershipId, row.id));
    expect(lines.map((line) => [line.kind, line.minutes, line.note])).toEqual([
      ["month", 300, "The first month"],
      ["month", 300, "The month from Monday, December 14, 2026"],
    ]);
    const [mail] = await world.emails("membership_month_paid");
    expect(mail).toMatchObject({ toEmail: "jane@example.com", subject: "Your membership: 5 hours added" });
    expect(mail.body).toContain("This month's payment for your membership Studio Paris, 5 hours a month went through ($300), and its 5 hours are on your code");
    expect(mail.body).toContain("You have 10 hours in all.");
    expect(mail.body).toContain("The next month is billed on Thursday, January 14, 2027.");

    // Nothing is recorded twice, however often it runs.
    expect(await bill(at("2026-12-20"))).toMatchObject({ monthsPaid: 0 });
    expect(await world.emails("membership_month_paid")).toHaveLength(1);
  });

  it("tells the member and the studio once when a month is not paid by the day after, and records it when it is paid later", async () => {
    const row = await join();
    world.billMonth(row.subscriptionId!, false);
    // On the day itself Square may still be at it: nothing is said.
    expect(await bill(at("2026-12-14", 12))).toEqual({ monthsPaid: 0, problems: 0, carriedOn: 0 });
    expect(await bill(at("2026-12-15", 12))).toMatchObject({ monthsPaid: 0, problems: 1 });
    const problem = "The payment of $300 for the month from Monday, December 14, 2026 did not go through.";
    expect(await rowOf(row.id)).toMatchObject({ status: "active", problem });
    const [told] = await world.emails("membership_payment_problem");
    expect(told).toMatchObject({ toEmail: "jane@example.com", subject: "Your membership Studio Paris, 5 hours a month: a payment did not go through" });
    expect(told.body).toContain(`${problem} The hours already on your code`);
    const [studio] = await world.emails("owner_membership_problem");
    expect(studio).toMatchObject({ toEmail: OWNER_EMAIL, subject: `ACTION NEEDED: membership ${row.code} was not paid` });

    expect(await bill(at("2026-12-15", 14))).toMatchObject({ problems: 0 });
    expect(await world.emails("membership_payment_problem")).toHaveLength(1);

    // Square took it on a later try.
    world.subscriptions[0].invoices[0].paid = true;
    expect(await bill(at("2026-12-15", 16))).toMatchObject({ monthsPaid: 1, problems: 0 });
    expect(await rowOf(row.id)).toMatchObject({ problem: null, paidThrough: "2027-01-14" });
    expect((await membershipsOf(world.db, "jane@example.com"))[0].minutesLeft).toBe(600);
  });

  it("stops a membership whose payments Square stopped, and cancels one cancelled at Square", async () => {
    const stopped = await join();
    const cancelled = await join("bob@example.com");
    world.subscriptions[0].stopped = true;
    world.subscriptions[1].endsOn = "2026-12-14";
    expect(await bill(at("2026-12-14", 12))).toMatchObject({ problems: 1 });
    expect(await rowOf(stopped.id)).toMatchObject({ status: "stopped", problem: "Square has stopped the monthly payments of your membership: it could not keep charging your card." });
    expect(await rowOf(cancelled.id)).toMatchObject({ status: "cancelled", endsOn: "2026-12-14" });
    expect((await world.emails("membership_cancelled")).map((mail) => mail.toEmail)).toEqual(["bob@example.com"]);
    // Neither is asked about again.
    world.billMonth(cancelled.subscriptionId!);
    expect(await bill(at("2026-12-20"))).toEqual({ monthsPaid: 0, problems: 0, carriedOn: 0 });
    // Their hours stay usable.
    expect((await membershipsOf(world.db, "jane@example.com"))[0]).toMatchObject({ status: "stopped", minutesLeft: 300 });
  });

  it("carries on a membership whose buying stopped after its first month was paid, and gives up one never paid", async () => {
    const plan = (await listPlans(world.db)).find((candidate) => candidate.name === "Studio Paris, 5 hours a month")!;
    const buy = (email: string) =>
      joinMembership(
        world.db,
        { planId: plan.id, customer: { name: "Jane Smith", email, phone: "407-555-0100" }, acceptTerms: true, paymentToken: MOCK_TOKEN_OK, requestId: randomUUID() },
        deps(NOW),
      );
    // The server stops right after the first month was paid.
    const saveCard = world.provider.memberships.saveCard;
    world.provider.memberships.saveCard = async () => {
      throw new Error("The server stopped.");
    };
    await expect(buy("jane@example.com")).rejects.toThrow("The server stopped.");
    world.provider.memberships.saveCard = saveCard;
    // No answer at all about another client's card.
    const charge = world.provider.charge;
    world.provider.charge = async () => ({ ok: false, unknown: true, message: "We could not reach the card processor." });
    expect(await buy("bob@example.com")).toMatchObject({ ok: false, code: "no_answer" });
    world.provider.charge = charge;

    // Within the hour the clients may still press again: nothing is done.
    expect(await bill(new Date(NOW.getTime() + 30 * 60_000))).toEqual({ monthsPaid: 0, problems: 0, carriedOn: 0 });
    expect(await bill(new Date(NOW.getTime() + 2 * 60 * 60_000))).toMatchObject({ carriedOn: 1 });
    expect((await membershipsOf(world.db, "jane@example.com"))[0]).toMatchObject({ status: "active", minutesLeft: 300, nextBilling: "2026-12-14" });
    expect((await world.emails("membership_started")).map((mail) => mail.toEmail)).toEqual(["jane@example.com"]);
    expect(await membershipsOf(world.db, "bob@example.com")).toEqual([]);
    const [unfinished] = await world.emails("owner_membership_unfinished");
    expect(unfinished.subject).toMatch(/^CHECK SQUARE: membership MEMBER-.+ was not finished$/);
    expect(unfinished.body).toContain("Look in Square for a payment of $300 with the reference MEMBER-");
  });

  it("records a month Square took before the member cancelled, with its hours, at the cancelling or by the task (the tester's finding)", async () => {
    const row = await join();
    // 14 December: Square takes the second month. That morning, before the task has asked, Jane cancels.
    world.billMonth(row.subscriptionId!);
    const cancelled = await cancelMembership(world.db, { email: "jane@example.com", role: "customer" }, row.id, { now: at("2026-12-14", 9), payments: world.provider, baseUrl: BASE_URL });
    expect(cancelled).toMatchObject({ ok: true, membership: { status: "cancelled", endsOn: "2027-01-14", minutesLeft: 600 } });
    // The month is recorded at once, before the email about the cancelling, which counts its hours.
    expect(await monthsOf(row.id)).toHaveLength(2);
    expect((await world.emails("membership_cancelled")).at(-1)!.body).toContain("January 14, 2027");
    expect(await world.emails("membership_month_paid")).toHaveLength(1);
    // Nothing is recorded twice afterwards.
    await bill(at("2026-12-14", 12));
    await bill(at("2027-01-10", 12));
    expect(await monthsOf(row.id)).toHaveLength(2);
    expect((await membershipsOf(world.db, "jane@example.com"))[0].minutesLeft).toBe(600);
  });

  it("records such a month later when Square cannot say at the cancelling, and stops asking once it is", async () => {
    const row = await join("bob@example.com");
    world.billMonth(row.subscriptionId!);
    // Square cancels, then cannot say what it billed.
    const subscriptionState = world.provider.memberships.subscriptionState;
    world.provider.memberships.subscriptionState = async () => ({ state: "unknown", message: "No answer from Square" });
    expectOk(await cancelMembership(world.db, { email: "bob@example.com", role: "customer" }, row.id, { now: at("2026-12-14", 9), payments: world.provider, baseUrl: BASE_URL }));
    world.provider.memberships.subscriptionState = subscriptionState;
    expect(await monthsOf(row.id)).toHaveLength(1);
    // The task asks about the cancelled membership until its months up to its end are recorded.
    expect(await bill(at("2026-12-14", 12))).toMatchObject({ monthsPaid: 1 });
    expect((await membershipsOf(world.db, "bob@example.com"))[0]).toMatchObject({ status: "cancelled", minutesLeft: 600 });
    const asked = (await rowOf(row.id)).billingCheckedAt;
    await bill(at("2026-12-20", 12));
    expect((await rowOf(row.id)).billingCheckedAt).toEqual(asked);
  });

  it("tells a month that was not paid once, even after a later month is paid, and clears it once none is left unpaid", async () => {
    const row = await join();
    world.billMonth(row.subscriptionId!, false); // 14 December: not paid
    expect(await bill(at("2026-12-15", 12))).toMatchObject({ problems: 1 });
    world.billMonth(row.subscriptionId!); // 14 January: paid
    for (const hour of [12, 14, 16]) await bill(at("2027-01-14", hour));
    expect(await world.emails("membership_payment_problem")).toHaveLength(1);
    expect(await world.emails("owner_membership_problem")).toHaveLength(1);
    expect((await rowOf(row.id)).problem).toContain("December 14, 2026 did not go through");
    // Square takes December on a later try: nothing is left unpaid.
    world.subscriptions[0].invoices.find((invoice) => invoice.day === "2026-12-14")!.paid = true;
    await bill(at("2027-01-16", 12));
    expect((await rowOf(row.id)).problem).toBeNull();
    expect(await world.emails("membership_payment_problem")).toHaveLength(1);
  });

  it("asks only about memberships of the processor set up now", async () => {
    const row = await join();
    world.billMonth(row.subscriptionId!);
    expect(await bill(at("2026-12-14", 12), { ...world.provider, name: "square-sandbox" })).toEqual({ monthsPaid: 0, problems: 0, carriedOn: 0 });
    expect(await bill(at("2026-12-14", 12))).toMatchObject({ monthsPaid: 1 });
  });
});
