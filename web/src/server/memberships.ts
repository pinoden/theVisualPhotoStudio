import { randomInt } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbLike } from "@/db/client";
import { bookings, MEMBERSHIP_STATUSES, membershipMinutes, membershipPayments, membershipPlanPrices, membershipPlans, membershipPlanStudios, memberships, studios } from "@/db/schema";
import { studioCombinationError } from "@/lib/catalog-view";
import { formatCents } from "@/lib/domain/pricing";
import { durationLabel, longDateLabel } from "@/lib/domain/time";
import { emailField, hashToken, lineField } from "./input-fields";
import {
  membershipCancelledEmail,
  membershipMonthPaidEmail,
  membershipProblemEmail,
  membershipStartedEmail,
  ownerMembershipProblemNotice,
  ownerMembershipRefundNotice,
  ownerMembershipUnfinishedNotice,
  queueEmail,
} from "./email";
import { minutesLeftOf } from "./membership-minutes";
import { monthsAfter, type PaymentProvider, type SubscriptionState } from "./payments";
import { normalizeCode, PROMO_PROBLEM_TEXT } from "./promos";
import { localDateOf } from "./tz";

/**
 * Memberships (follow-up 3; the owners' answers of 2026-11-17 and 2026-11-18, recorded under follow-up 3 in
 * ProjectLibrary.md, with the plan they are built by). A plan gives studio minutes each month for a monthly price, in
 * one studio or in the studios of a bundle, each of which the minutes can be spent in alone too. The owners add plans,
 * change them and switch them on and off; a plan is never deleted, as the memberships sold refer to it.
 */

export const PLAN_NAME_MAX = 80;
export const PLAN_DESCRIPTION_MAX = 500;
/** A plan gives whole or half hours: from half an hour to 100 hours a month. */
const PLAN_MINUTES_RANGE = [30, 6000] as const;
/** At most $10,000 a month. */
const PLAN_PRICE_MAX_CENTS = 1_000_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PlanInput {
  name: string;
  description: string;
  /** Studio minutes each month. */
  minutes: number;
  /** The price of a month. */
  priceCents: number;
}

export interface PlanView extends PlanInput {
  id: string;
  active: boolean;
  /** Its studios, in the studios' own order. */
  studios: { id: string; name: string; slug: string }[];
}

/** Every plan, those no longer offered too, in the owners' order. */
export async function listPlans(db: DbLike): Promise<PlanView[]> {
  const plans = await db.select().from(membershipPlans).orderBy(asc(membershipPlans.sortOrder), asc(membershipPlans.createdAt));
  const links = await db
    .select({ planId: membershipPlanStudios.planId, id: studios.id, name: studios.name, slug: studios.slug })
    .from(membershipPlanStudios)
    .innerJoin(studios, eq(studios.id, membershipPlanStudios.studioId))
    .orderBy(asc(studios.sortOrder));
  return plans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    description: plan.description,
    minutes: plan.minutes,
    priceCents: plan.priceCents,
    active: plan.active,
    studios: links.filter((link) => link.planId === plan.id).map(({ id, name, slug }) => ({ id, name, slug })),
  }));
}

export type SavePlanResult = { ok: true; id: string } | { ok: false; message: string };

function planProblem(input: PlanInput): string | null {
  const name = input.name.replace(/\s+/g, " ").trim();
  if (name.length < 1 || name.length > PLAN_NAME_MAX) return `Give the plan a name of up to ${PLAN_NAME_MAX} characters.`;
  if (input.description.trim().length > PLAN_DESCRIPTION_MAX) return `Keep the description under ${PLAN_DESCRIPTION_MAX} characters.`;
  const [least, most] = PLAN_MINUTES_RANGE;
  if (!Number.isInteger(input.minutes) || input.minutes < least || input.minutes > most || input.minutes % 30 !== 0) {
    return "Give the hours a month as whole or half hours, from 0.5 to 100.";
  }
  if (!Number.isInteger(input.priceCents) || input.priceCents <= 0 || input.priceCents > PLAN_PRICE_MAX_CENTS) {
    return "Enter the price of a month as an amount up to $10,000, for example 330 or 330.50.";
  }
  return null;
}

/**
 * Change a plan's name, description, hours or price. Its studios stay as they were made: they are what its members
 * bought. A new price or number of hours applies to the members who join after it (step 2 keeps each member's own).
 */
export async function savePlan(db: DbLike, planId: string, input: PlanInput): Promise<SavePlanResult> {
  const problem = planProblem(input);
  if (problem) return { ok: false, message: problem };
  if (!UUID.test(planId)) return { ok: false, message: "Unknown plan." };
  const updated = await db
    .update(membershipPlans)
    .set({ name: input.name.replace(/\s+/g, " ").trim(), description: input.description.trim(), minutes: input.minutes, priceCents: input.priceCents })
    .where(eq(membershipPlans.id, planId))
    .returning({ id: membershipPlans.id });
  return updated.length === 1 ? { ok: true, id: planId } : { ok: false, message: "Unknown plan." };
}

/** Add a plan, offered at once, after the others. Its studios are those that can be booked together. */
export async function addPlan(db: DbLike, studioIds: readonly string[], input: PlanInput): Promise<SavePlanResult> {
  const problem = planProblem(input);
  if (problem) return { ok: false, message: problem };
  const chosen = [...new Set(studioIds)];
  if (chosen.length === 0 || chosen.length !== studioIds.length || !chosen.every((studioId) => UUID.test(studioId))) {
    return { ok: false, message: "Choose the studio, or the studios of a bundle, the plan is for." };
  }
  const known = await db.select({ id: studios.id, slug: studios.slug }).from(studios).where(inArray(studios.id, chosen));
  if (known.length !== chosen.length) return { ok: false, message: "Unknown studio." };
  const together = studioCombinationError(known, chosen);
  if (together) return { ok: false, message: `A plan is for studios that can be booked together. ${together}` };

  const orders = await db.select({ sortOrder: membershipPlans.sortOrder }).from(membershipPlans);
  const [plan] = await db
    .insert(membershipPlans)
    .values({
      name: input.name.replace(/\s+/g, " ").trim(),
      description: input.description.trim(),
      minutes: input.minutes,
      priceCents: input.priceCents,
      sortOrder: Math.max(-1, ...orders.map((row) => row.sortOrder)) + 1,
    })
    .returning({ id: membershipPlans.id });
  await db.insert(membershipPlanStudios).values(chosen.map((studioId) => ({ planId: plan.id, studioId })));
  return { ok: true, id: plan.id };
}

/** Offer a plan, or stop offering it: its members keep it. */
export async function setPlanActive(db: DbLike, planId: string, active: boolean): Promise<boolean> {
  if (!UUID.test(planId)) return false;
  const updated = await db.update(membershipPlans).set({ active }).where(eq(membershipPlans.id, planId)).returning({ id: membershipPlans.id });
  return updated.length === 1;
}

/**
 * The studios a plan can be for, in the studios' order: each studio alone, and every set of studios that can be
 * booked together (not Blanche and Dayglow without Paris).
 */
export function planStudioChoices(all: readonly { id: string; name: string; slug: string }[]): { ids: string[]; label: string }[] {
  const sets: { id: string; name: string; slug: string }[][] = [];
  for (let mask = 1; mask < 1 << all.length; mask++) sets.push(all.filter((_, index) => (mask & (1 << index)) !== 0));
  return sets
    .filter((set) => studioCombinationError(set, set.map((studio) => studio.id)) === null)
    .sort((a, b) => a.length - b.length)
    .map((set) => ({
      ids: set.map((studio) => studio.id),
      label: set.length === all.length && all.length > 2 ? "All the studios" : set.map((studio) => studio.name).join(" and "),
    }));
}

// ── Buying a membership (step 2) ─────────────────────────────────────────────

const joinInput = z.object({
  planId: z.uuid(),
  customer: z.object({ name: lineField(2, 120), email: emailField, phone: lineField(7, 40) }),
  acceptTerms: z.literal(true),
  paymentToken: z.string().min(1).max(1000),
  /** The buying page's id for this attempt, a random UUID, sent again unchanged only when no answer came. */
  requestId: z.uuid(),
  /**
   * The monthly price and minutes the page showed, which the client agreed to: when the owners changed the plan since,
   * nothing is charged and the client is asked to look again (the tester's finding of 2026-11-18), as a booking is.
   */
  expected: z.object({ priceCents: z.number().int().positive(), minutes: z.number().int().positive() }).optional(),
});

export interface JoinDeps {
  now: Date;
  payments: PaymentProvider | null;
  baseUrl: string;
  ownerEmail: string | null;
}

/** A membership as its member and the pages see it. */
export interface MembershipView {
  id: string;
  code: string;
  email: string;
  planName: string;
  minutesPerMonth: number;
  priceCents: number;
  status: "starting" | "active" | "cancelled" | "stopped";
  startedOn: string;
  /** While it is billed each month: the day the next month is billed. */
  nextBilling: string | null;
  /** Once cancelled: the day the month paid for ends. */
  endsOn: string | null;
  minutesLeft: number;
}

export type JoinProblem =
  | "invalid_input"
  | "not_offered"
  | "price_changed"
  | "payments_unavailable"
  | "declined"
  | "no_answer"
  | "not_set_up"
  | "failed_before"
  | "rate_limited";
export type JoinResult = { ok: true; membership: MembershipView } | { ok: false; status: number; code: JoinProblem; message: string };

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** A member's code: MEMBER- and eight letters and numbers that cannot be mistaken for one another. */
function membershipCode(): string {
  let body = "";
  for (let i = 0; i < 8; i++) body += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `MEMBER-${body.slice(0, 4)}-${body.slice(4)}`;
}

type MembershipRow = typeof memberships.$inferSelect;

async function viewOf(db: DbLike, row: MembershipRow): Promise<MembershipView> {
  return {
    id: row.id,
    code: row.code,
    email: row.email,
    planName: row.planName,
    minutesPerMonth: row.minutesPerMonth,
    priceCents: row.priceCents,
    status: row.status === "failed" ? "stopped" : row.status,
    startedOn: row.startedOn,
    nextBilling: row.status === "active" ? row.paidThrough : null,
    endsOn: row.endsOn,
    minutesLeft: await minutesLeftOf(db, row.id),
  };
}

/** A client's memberships, newest first: every one bought, with its minutes left. Never those that failed to start. */
export async function membershipsOf(db: DbLike, email: string): Promise<MembershipView[]> {
  const rows = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.email, email.trim().toLowerCase()), ne(memberships.status, "failed")))
    .orderBy(desc(memberships.createdAt));
  const views: MembershipView[] = [];
  for (const row of rows) views.push(await viewOf(db, row));
  return views;
}

/** What the processor calls the plan's price: made the first time it is needed, then reused. */
async function priceAtProcessor(db: DbLike, payments: PaymentProvider, row: MembershipRow): Promise<{ ok: true; variationId: string } | { ok: false; message: string }> {
  const samePlan = and(eq(membershipPlanPrices.planId, row.planId), eq(membershipPlanPrices.provider, payments.name));
  const [made] = await db.select().from(membershipPlanPrices).where(and(samePlan, eq(membershipPlanPrices.priceCents, row.priceCents)));
  if (made) return { ok: true, variationId: made.variationId };
  const [other] = await db.select({ processorPlanId: membershipPlanPrices.processorPlanId }).from(membershipPlanPrices).where(samePlan).limit(1);
  const result = await payments.memberships.createPlanPrice({
    planName: row.planName,
    processorPlanId: other?.processorPlanId ?? null,
    priceCents: row.priceCents,
    idempotencyKey: `${row.planId}-${row.priceCents}`,
  });
  if (!result.ok) return result;
  await db
    .insert(membershipPlanPrices)
    .values({ planId: row.planId, provider: payments.name, priceCents: row.priceCents, processorPlanId: result.processorPlanId, variationId: result.variationId })
    .onConflictDoNothing();
  const [kept] = await db.select().from(membershipPlanPrices).where(and(samePlan, eq(membershipPlanPrices.priceCents, row.priceCents)));
  return { ok: true, variationId: kept?.variationId ?? result.variationId };
}

const NOT_SET_UP = "The monthly payments could not be set up with this card, so the membership was not started, and the first month was refunded to your card. Please try again, or contact the studio.";
const NOT_SET_UP_NOT_REFUNDED =
  "The monthly payments could not be set up with this card, so the membership was not started. The first month's refund did not go through either: the studio has been told, and will refund it.";

/**
 * Buy a membership (step 2 of the plan under follow-up 3): its first month is charged now, the card of that payment
 * is kept by the processor, and the processor's subscription bills it monthly from the same day of the next month.
 * The plan's minutes are added once the first month is paid, and the member is emailed their code.
 *
 * Every step at the processor carries a key made from the membership, so that pressing again after no answer, or
 * twice, never charges or subscribes twice: a membership being bought (`starting`) is found by the page's request id
 * and carried on from where it stopped. When the card cannot be kept or the subscription cannot be made, the first
 * month is refunded and the membership is not started; when that refund fails too, the studio is told.
 */
export async function joinMembership(db: Db, raw: unknown, deps: JoinDeps): Promise<JoinResult> {
  const parsed = joinInput.safeParse(raw);
  if (!parsed.success) return { ok: false, status: 400, code: "invalid_input", message: "Please check your details and agree to the membership terms." };
  const input = parsed.data;
  if (!deps.payments) return { ok: false, status: 503, code: "payments_unavailable", message: "Online payment is not available right now. Please contact the studio." };
  const payments = deps.payments;
  const requestKey = hashToken(`membership:${input.requestId.toLowerCase()}`);

  let [row] = await db.select().from(memberships).where(eq(memberships.requestKey, requestKey));
  if (row && row.status === "failed") return { ok: false, status: 409, code: "failed_before", message: row.problem ?? NOT_SET_UP };
  if (row && row.status !== "starting") return { ok: true, membership: await viewOf(db, row) };
  if (!row) {
    const [plan] = await db.select().from(membershipPlans).where(and(eq(membershipPlans.id, input.planId), eq(membershipPlans.active, true)));
    if (!plan) return { ok: false, status: 409, code: "not_offered", message: "This membership is no longer offered. Please choose another." };
    if (input.expected && (input.expected.priceCents !== plan.priceCents || input.expected.minutes !== plan.minutes)) {
      return {
        ok: false,
        status: 409,
        code: "price_changed",
        message: `This membership has changed since the page was opened: it is now ${formatCents(plan.priceCents)} a month for ${durationLabel(plan.minutes)} of studio time. Nothing was charged. Please look at it again, and agree to the terms at that price.`,
      };
    }
    for (let attempt = 0; attempt < 5 && !row; attempt++) {
      [row] = await db
        .insert(memberships)
        .values({
          email: input.customer.email,
          name: input.customer.name,
          phone: input.customer.phone,
          planId: plan.id,
          planName: plan.name,
          minutesPerMonth: plan.minutes,
          priceCents: plan.priceCents,
          code: membershipCode(),
          status: "starting",
          requestKey,
          provider: payments.name,
          startedOn: localDateOf(deps.now),
          createdAt: deps.now,
        })
        .onConflictDoNothing()
        .returning();
      // Pressed twice at once: the other request made it, and this one carries on with it.
      if (!row) [row] = await db.select().from(memberships).where(eq(memberships.requestKey, requestKey));
    }
    if (!row) throw new Error("No membership code was free.");
  }

  // The customer at the processor: the one an earlier membership of the same client has, or a new one.
  let customerId = row.customerId;
  if (!customerId) {
    const [earlier] = await db
      .select({ customerId: memberships.customerId })
      .from(memberships)
      .where(and(eq(memberships.email, row.email), eq(memberships.provider, payments.name), isNotNull(memberships.customerId)))
      .limit(1);
    const made = earlier?.customerId ? { ok: true as const, customerId: earlier.customerId } : await payments.memberships.createCustomer({ email: row.email, name: row.name, idempotencyKey: `${row.id}-cus` });
    if (!made.ok) return { ok: false, status: 502, code: "no_answer", message: "We could not reach the card processor. Please try again in a moment: you have not been charged." };
    customerId = made.customerId;
    await db.update(memberships).set({ customerId }).where(eq(memberships.id, row.id));
  }
  const price = await priceAtProcessor(db, payments, row);
  if (!price.ok) return { ok: false, status: 502, code: "no_answer", message: "We could not reach the card processor. Please try again in a moment: you have not been charged." };

  // The first month.
  const [paidBefore] = await db.select().from(membershipPayments).where(eq(membershipPayments.membershipId, row.id)).limit(1);
  let paymentId = paidBefore?.processorId;
  if (!paymentId) {
    const charged = await payments.charge({
      amountCents: row.priceCents,
      token: input.paymentToken,
      customerInitiated: true,
      idempotencyKey: row.id,
      reference: row.code,
      note: `Membership ${row.code}: ${row.planName}, the first month`,
      buyerEmail: row.email,
      customerId,
    });
    if (!charged.ok) {
      if (charged.unknown) {
        return { ok: false, status: 502, code: "no_answer", message: "We could not reach the card processor. Please press the button again: your card will not be charged twice." };
      }
      await db.update(memberships).set({ status: "failed", problem: `The card was refused: ${charged.detail ?? charged.message}` }).where(eq(memberships.id, row.id));
      return { ok: false, status: 402, code: "declined", message: charged.message };
    }
    paymentId = charged.paymentId;
    await db
      .insert(membershipPayments)
      .values({ membershipId: row.id, processorId: paymentId, amountCents: row.priceCents, periodStart: row.startedOn, paidAt: deps.now })
      .onConflictDoNothing();
  }

  return finishStarting(db, payments, row, customerId, price.variationId, paymentId, deps);
}

/**
 * The rest of buying a membership once its first month is paid: the card kept, the months after the first billed to
 * it, and the membership started, with its first month's minutes and the member's email. When the card cannot be kept
 * or the subscription made, the first month is given back (`giveBack`). Used by `joinMembership`, and by the scheduled
 * task for a membership whose buying stopped after its payment (`carryOn`).
 */
async function finishStarting(
  db: Db,
  payments: PaymentProvider,
  row: MembershipRow,
  customerId: string,
  variationId: string,
  paymentId: string,
  deps: JoinDeps,
): Promise<JoinResult> {
  const price = { variationId };
  // The card kept, and the months after the first billed to it.
  const firstBilling = monthsAfter(row.startedOn, 1);
  const card = row.cardId ? { ok: true as const, cardId: row.cardId } : await payments.memberships.saveCard({ paymentId, customerId, idempotencyKey: `${row.id}-card` });
  if (card.ok && !row.cardId) await db.update(memberships).set({ cardId: card.cardId }).where(eq(memberships.id, row.id));
  const subscribed = card.ok
    ? await payments.memberships.subscribe({ customerId, cardId: card.cardId, variationId: price.variationId, startDate: firstBilling, idempotencyKey: `${row.id}-sub` })
    : card;
  if (!subscribed.ok) return giveBack(db, payments, row, paymentId, subscribed.message, deps);

  const started = await db.transaction(async (tx) => {
    const [active] = await tx
      .update(memberships)
      .set({ status: "active", subscriptionId: subscribed.subscriptionId, paidThrough: firstBilling })
      .where(and(eq(memberships.id, row.id), eq(memberships.status, "starting")))
      .returning();
    // Pressed twice at once: the other request started it, and did the rest.
    if (!active) return null;
    const [payment] = await tx.select().from(membershipPayments).where(eq(membershipPayments.processorId, paymentId));
    await tx.insert(membershipMinutes).values({ membershipId: active.id, minutes: active.minutesPerMonth, kind: "month", paymentId: payment.id, note: "The first month", actor: "the site" });
    const base = deps.baseUrl.replace(/\/$/, "");
    await queueEmail(
      tx,
      membershipStartedEmail({
        to: active.email,
        name: active.name,
        planName: active.planName,
        minutes: active.minutesPerMonth,
        priceCents: active.priceCents,
        code: active.code,
        nextBilling: firstBilling,
        bookUrl: `${base}/book`,
        accountUrl: `${base}/account/membership`,
      }),
    );
    return active;
  });
  const [now] = await db.select().from(memberships).where(eq(memberships.id, row.id));
  return started || now.status !== "starting" ? { ok: true, membership: await viewOf(db, now) } : { ok: false, status: 409, code: "no_answer", message: NOT_SET_UP };
}

/** The membership could not be started after its first month was paid: the month is refunded, and it is marked failed. */
async function giveBack(db: Db, payments: PaymentProvider, row: MembershipRow, paymentId: string, why: string, deps: JoinDeps): Promise<JoinResult> {
  const refund = await payments.refund({ paymentId, amountCents: row.priceCents, idempotencyKey: `${row.id}-ref`, reason: "The membership could not be set up" });
  await db.transaction(async (tx) => {
    await tx
      .update(memberships)
      .set({ status: "failed", problem: `The monthly payments could not be set up: ${why}${refund.ok ? "" : `. The first month's refund failed too: ${refund.message}`}` })
      .where(eq(memberships.id, row.id));
    if (refund.ok) await tx.update(membershipPayments).set({ refundedAt: deps.now }).where(eq(membershipPayments.processorId, paymentId));
    else if (deps.ownerEmail) {
      await queueEmail(tx, ownerMembershipRefundNotice({ to: deps.ownerEmail, code: row.code, customer: `${row.name} (${row.email})`, amountCents: row.priceCents, reason: refund.message }));
    }
  });
  return { ok: false, status: 502, code: "not_set_up", message: refund.ok ? NOT_SET_UP : NOT_SET_UP_NOT_REFUNDED };
}

// ── The member's view, and cancelling ────────────────────────────────────────

/** A month a membership paid, for the member's account. */
export interface MembershipPaymentView {
  periodStart: string;
  amountCents: number;
  paidAt: Date;
  refunded: boolean;
}

export async function membershipPaymentsOf(db: DbLike, membershipId: string): Promise<MembershipPaymentView[]> {
  const rows = await db.select().from(membershipPayments).where(eq(membershipPayments.membershipId, membershipId)).orderBy(desc(membershipPayments.periodStart));
  return rows.map((row) => ({ periodStart: row.periodStart, amountCents: row.amountCents, paidAt: row.paidAt, refunded: row.refundedAt !== null }));
}

export type CancelMembershipResult =
  | { ok: true; membership: MembershipView }
  | { ok: false; code: "not_found" | "not_active" | "no_answer"; message: string };

const NO_SUCH_MEMBERSHIP: CancelMembershipResult = { ok: false, code: "not_found", message: "Membership not found." };

/**
 * Cancel a membership, by its member in their account or by an owner: the processor bills it no more, and the month
 * paid for runs to its end. The minutes left stay usable for as long as there are any (the owner's answer of
 * 2026-11-18). Cancelling one already cancelled changes nothing.
 */
export async function cancelMembership(
  db: Db,
  actor: { email: string; role: string },
  membershipId: string,
  deps: { now: Date; payments: PaymentProvider | null; baseUrl: string },
): Promise<CancelMembershipResult> {
  if (!UUID.test(membershipId)) return NO_SUCH_MEMBERSHIP;
  const [row] = await db.select().from(memberships).where(eq(memberships.id, membershipId));
  if (!row || row.status === "failed" || (actor.role !== "owner" && row.email !== actor.email.trim().toLowerCase())) return NO_SUCH_MEMBERSHIP;
  if (row.status === "cancelled") return { ok: true, membership: await viewOf(db, row) };
  if (row.status !== "active" || !row.subscriptionId) {
    return { ok: false, code: "not_active", message: "This membership is not billed each month, so there is nothing to cancel." };
  }
  // Billed by another processor than the one set up now (in test mode, or with Square's other account): this one cannot stop it.
  if (!deps.payments || deps.payments.name !== row.provider) {
    return { ok: false, code: "no_answer", message: "The monthly payments cannot be stopped from here at the moment. Please contact the studio." };
  }
  const stopped = await deps.payments.memberships.cancelSubscription(row.subscriptionId);
  if (!stopped.ok) return { ok: false, code: "no_answer", message: "We could not reach the card processor, so nothing was changed. Please try again in a moment." };
  const endsOn = stopped.endsOn ?? row.paidThrough;
  // Square took a month the site has not recorded yet (it ends later than what is recorded paid): its hours are put on
  // the code first, so that the email says what is left. When Square cannot say now, the scheduled task records it.
  if (endsOn && row.paidThrough && endsOn > row.paidThrough) {
    const state = await deps.payments.memberships.subscriptionState(row.subscriptionId);
    if (state.state !== "unknown") await recordPaidMonths(db, { ...row, endsOn }, state, deps);
  }
  await db.transaction(async (tx) => {
    const [cancelled] = await tx
      .update(memberships)
      .set({ status: "cancelled", cancelledAt: deps.now, endsOn })
      .where(and(eq(memberships.id, row.id), eq(memberships.status, "active")))
      .returning();
    if (!cancelled) return;
    await queueEmail(
      tx,
      membershipCancelledEmail({
        to: row.email,
        name: row.name,
        planName: row.planName,
        code: row.code,
        endsOn: endsOn && endsOn > localDateOf(deps.now) ? endsOn : null,
        minutesLeft: await minutesLeftOf(tx, row.id),
        bookUrl: `${deps.baseUrl.replace(/\/$/, "")}/book`,
      }),
    );
  });
  const [now] = await db.select().from(memberships).where(eq(memberships.id, row.id));
  return { ok: true, membership: await viewOf(db, now) };
}

// ── Spending minutes on a booking (step 3) ───────────────────────────────────

/** A membership whose minutes can pay for a booking: what is left on it, and the processor it was bought with. */
export interface UsableMembership {
  id: string;
  code: string;
  minutesLeft: number;
  provider: string;
  /** The studios its plan is for, each alone or together: the booking screen applies the hours only to those. */
  studioIds: string[];
  /** Their names, in the studios' order, for the screen to say what the hours are for. */
  studioNames: string[];
}

/** True for a membership's code (`MEMBER-XXXX-XXXX`), which the code field takes as it takes the others. */
export function isMembershipCode(raw: string): boolean {
  return normalizeCode(raw).startsWith("MEMBER-");
}

/** "Studio Blanche or Studio Paris". */
const orList = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`);

/**
 * Whether a membership's code can pay for a booking of these studios, made with this email address: a membership that
 * was bought (its hours stay usable once it is cancelled or stopped), of this client, with minutes left, whose plan is
 * for every studio booked (a bundle's plan for any one of them too), and not for a photography session.
 */
export async function findUsableMembership(
  db: DbLike,
  rawCode: string,
  email: string,
  booking: { studioIds: readonly string[]; photography: boolean },
): Promise<{ ok: true; membership: UsableMembership } | { ok: false; message: string }> {
  const [row] = await db.select().from(memberships).where(eq(memberships.code, normalizeCode(rawCode)));
  if (!row || row.status === "starting" || row.status === "failed") return { ok: false, message: PROMO_PROBLEM_TEXT.not_found };
  if (row.email !== email.trim().toLowerCase()) return { ok: false, message: PROMO_PROBLEM_TEXT.wrong_email };
  if (booking.photography) return { ok: false, message: "Membership hours are for studio rentals: they cannot pay for a photography session." };
  const covered = await db
    .select({ studioId: membershipPlanStudios.studioId, name: studios.name })
    .from(membershipPlanStudios)
    .innerJoin(studios, eq(studios.id, membershipPlanStudios.studioId))
    .where(eq(membershipPlanStudios.planId, row.planId))
    .orderBy(asc(studios.sortOrder));
  if (!booking.studioIds.every((id) => covered.some((studio) => studio.studioId === id))) {
    return { ok: false, message: `This membership's hours are for ${orList(covered.map((studio) => studio.name))}, so they cannot pay for this booking.` };
  }
  const minutesLeft = await minutesLeftOf(db, row.id);
  if (minutesLeft <= 0) return { ok: false, message: "No hours are left on this membership. Each month paid adds its hours." };
  return {
    ok: true,
    membership: { id: row.id, code: row.code, minutesLeft, provider: row.provider, studioIds: covered.map((studio) => studio.studioId), studioNames: covered.map((studio) => studio.name) },
  };
}

// ── Each month (step 4) ──────────────────────────────────────────────────────

/** Ask the processor about a membership whose month has come at most this often: it bills once a month. */
const CHECK_EVERY_MS = 60 * 60_000;
/** A membership left being bought this long is carried on, or given up when its first month was never recorded paid. */
const CARRY_ON_AFTER_MS = 60 * 60_000;

export interface MembershipBillingSummary {
  /** Months paid, recorded with their minutes. */
  monthsPaid: number;
  /** Members (and the studio) told that a month was not paid, or that the payments stopped. */
  problems: number;
  /** Memberships whose buying stopped after their first month was paid, started now. */
  carriedOn: number;
}

/**
 * The scheduled task's part in memberships (step 4 of the plan under follow-up 3):
 *  - A membership whose buying stopped after its first month was paid (the client left, the server stopped) is carried
 *    on; one with no payment recorded an hour on is given up, and the studio is asked to check Square for one.
 *  - Each active membership whose next month has come is asked about, at most once an hour: every month Square was paid
 *    is recorded once, with its minutes, and the member is emailed; a month not paid by the day after it was due, or
 *    payments Square stopped, are told to the member and the studio once; a subscription cancelled at Square is
 *    cancelled here too. Never a month from the day a cancelled membership ends.
 * Only memberships of the processor set up now: the sandbox's are unknown to the live account, and the other way round.
 */
export async function runMembershipBilling(db: Db, deps: JoinDeps): Promise<MembershipBillingSummary> {
  const summary: MembershipBillingSummary = { monthsPaid: 0, problems: 0, carriedOn: 0 };
  const payments = deps.payments;
  if (!payments) return summary;

  const stuck = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.status, "starting"), eq(memberships.provider, payments.name), lt(memberships.createdAt, new Date(deps.now.getTime() - CARRY_ON_AFTER_MS))));
  for (const row of stuck) if (await carryOn(db, payments, row, deps)) summary.carriedOn++;

  const today = localDateOf(deps.now);
  const due = await db
    .select()
    .from(memberships)
    .where(
      and(
        or(
          // Its next month has come, or a month was not paid: asked until Square takes it, which it may on a later try.
          and(eq(memberships.status, "active"), or(lte(memberships.paidThrough, today), isNotNull(memberships.problem))),
          // Cancelled with a month Square took before the cancelling not recorded yet (the tester's finding of
          // 2026-11-18): asked until the months up to its end are, for a while after it ends at most.
          and(
            eq(memberships.status, "cancelled"),
            isNotNull(memberships.endsOn),
            lte(memberships.paidThrough, today),
            lt(memberships.paidThrough, memberships.endsOn),
            gte(memberships.endsOn, monthsAfter(today, -2)),
          ),
        ),
        eq(memberships.provider, payments.name),
        isNotNull(memberships.subscriptionId),
        or(isNull(memberships.billingCheckedAt), lt(memberships.billingCheckedAt, new Date(deps.now.getTime() - CHECK_EVERY_MS))),
      ),
    );
  for (const row of due) {
    const settled = await settleMonths(db, payments, row, deps);
    summary.monthsPaid += settled.months;
    summary.problems += settled.problems;
  }
  return summary;
}

/** A membership left being bought: carried on from its paid first month, or given up when none was recorded. */
async function carryOn(db: Db, payments: PaymentProvider, row: MembershipRow, deps: JoinDeps): Promise<boolean> {
  const [paid] = await db.select().from(membershipPayments).where(eq(membershipPayments.membershipId, row.id)).limit(1);
  if (paid && row.customerId) {
    const price = await priceAtProcessor(db, payments, row);
    if (!price.ok) return false; // the processor did not answer: next time
    return (await finishStarting(db, payments, row, row.customerId, price.variationId, paid.processorId, deps)).ok;
  }
  // No answer ever came about the card, and the client has not pressed again: Square may have charged it all the same.
  await db.transaction(async (tx) => {
    const [given] = await tx
      .update(memberships)
      .set({ status: "failed", problem: "No answer came about the card, and the membership was not started. The studio was asked to look in Square for a payment to refund." })
      .where(and(eq(memberships.id, row.id), eq(memberships.status, "starting")))
      .returning();
    if (given && deps.ownerEmail) {
      await queueEmail(
        tx,
        ownerMembershipUnfinishedNotice({ to: deps.ownerEmail, code: row.code, customer: `${row.name} (${row.email})`, planName: row.planName, amountCents: row.priceCents }),
      );
    }
  });
  return false;
}

/**
 * One membership whose next month has come, or a cancelled one with a month taken before the cancelling not recorded
 * yet: its months paid, a problem with one, and what Square did with it.
 */
async function settleMonths(db: Db, payments: PaymentProvider, row: MembershipRow, deps: JoinDeps): Promise<{ months: number; problems: number }> {
  await db.update(memberships).set({ billingCheckedAt: deps.now }).where(eq(memberships.id, row.id));
  const state = await payments.memberships.subscriptionState(row.subscriptionId!);
  if (state.state === "unknown") return { months: 0, problems: 0 };
  const months = await recordPaidMonths(db, row, state, deps);
  const counts = (day: string) => day !== "" && !(row.endsOn !== null && day >= row.endsOn);

  // What went wrong, told once: payments Square stopped, or a month not paid by the day after it was due. A later month
  // paid does not put the earlier one right: the problem stays, untold again, until no month is left unpaid.
  const today = localDateOf(deps.now);
  const unpaid = state.invoices.filter((invoice) => !invoice.paid && counts(invoice.day) && invoice.day < today).sort((a, b) => (a.day < b.day ? -1 : 1))[0];
  const problem =
    state.state === "stopped"
      ? "Square has stopped the monthly payments of your membership: it could not keep charging your card."
      : unpaid
        ? `The payment of ${formatCents(unpaid.amountCents > 0 ? unpaid.amountCents : row.priceCents)} for the month from ${longDateLabel(unpaid.day)} did not go through.`
        : null;
  const [now] = await db.select().from(memberships).where(eq(memberships.id, row.id));
  if (!problem && now.problem) await db.update(memberships).set({ problem: null }).where(eq(memberships.id, row.id));
  if (problem && now.problem !== problem) {
    await db.transaction(async (tx) => {
      await tx.update(memberships).set({ problem, ...(state.state === "stopped" ? { status: "stopped" as const } : {}) }).where(eq(memberships.id, row.id));
      await queueEmail(tx, membershipProblemEmail({ to: row.email, name: row.name, planName: row.planName, problem, code: row.code, minutesLeft: await minutesLeftOf(tx, row.id) }));
      if (deps.ownerEmail) {
        await queueEmail(tx, ownerMembershipProblemNotice({ to: deps.ownerEmail, code: row.code, customer: `${row.name} (${row.email})`, planName: row.planName, problem }));
      }
    });
    return { months, problems: 1 };
  }
  // Cancelled at Square itself (in its dashboard): cancelled here too, and the member told as when they cancel.
  if (state.state === "cancelled" && now.status === "active") {
    const endsOn = state.endsOn ?? now.paidThrough;
    await db.transaction(async (tx) => {
      const [cancelled] = await tx
        .update(memberships)
        .set({ status: "cancelled", cancelledAt: deps.now, endsOn })
        .where(and(eq(memberships.id, row.id), eq(memberships.status, "active")))
        .returning();
      if (!cancelled) return;
      await queueEmail(
        tx,
        membershipCancelledEmail({
          to: row.email,
          name: row.name,
          planName: row.planName,
          code: row.code,
          endsOn: endsOn && endsOn > today ? endsOn : null,
          minutesLeft: await minutesLeftOf(tx, row.id),
          bookUrl: `${deps.baseUrl.replace(/\/$/, "")}/book`,
        }),
      );
    });
  }
  return { months, problems: 0 };
}

/**
 * Every month Square was paid for that the site has not recorded, once each, with its minutes and the member's email;
 * never one from the day a cancelled membership ends. Answers how many were recorded.
 */
async function recordPaidMonths(
  db: Db,
  row: MembershipRow,
  state: Exclude<SubscriptionState, { state: "unknown" }>,
  deps: Pick<JoinDeps, "now" | "baseUrl">,
): Promise<number> {
  const accountUrl = `${deps.baseUrl.replace(/\/$/, "")}/account/membership`;
  const known = new Set((await db.select({ id: membershipPayments.processorId }).from(membershipPayments).where(eq(membershipPayments.membershipId, row.id))).map((payment) => payment.id));
  const counts = (day: string) => day !== "" && !(row.endsOn !== null && day >= row.endsOn);

  let months = 0;
  let paidThrough = row.paidThrough ?? monthsAfter(row.startedOn, 1);
  for (const invoice of [...state.invoices].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))) {
    if (!invoice.paid || known.has(invoice.id) || !counts(invoice.day)) continue;
    const through = [paidThrough, monthsAfter(invoice.day, 1), state.paidThrough ?? ""].reduce((latest, day) => (day > latest ? day : latest));
    const recorded = await db.transaction(async (tx) => {
      const [payment] = await tx
        .insert(membershipPayments)
        .values({ membershipId: row.id, processorId: invoice.id, amountCents: invoice.amountCents > 0 ? invoice.amountCents : row.priceCents, periodStart: invoice.day, paidAt: deps.now })
        .onConflictDoNothing()
        .returning();
      if (!payment) return false;
      await tx.insert(membershipMinutes).values({
        membershipId: row.id,
        minutes: row.minutesPerMonth,
        kind: "month",
        paymentId: payment.id,
        note: `The month from ${longDateLabel(invoice.day)}`,
        actor: "the site",
      });
      await tx.update(memberships).set({ paidThrough: through }).where(eq(memberships.id, row.id));
      await queueEmail(
        tx,
        membershipMonthPaidEmail({
          to: row.email,
          name: row.name,
          planName: row.planName,
          minutes: row.minutesPerMonth,
          priceCents: payment.amountCents,
          code: row.code,
          minutesLeft: await minutesLeftOf(tx, row.id),
          nextBilling: through,
          accountUrl,
        }),
      );
      return true;
    });
    if (recorded) {
      months++;
      paidThrough = through;
    }
  }
  return months;
}

// ── The owners' view (step 5) ────────────────────────────────────────────────

export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/** A membership as the owners' list shows it. */
export interface MemberRow {
  id: string;
  name: string;
  email: string;
  code: string;
  planName: string;
  priceCents: number;
  status: MembershipStatus;
  startedOn: string;
  minutesLeft: number;
  /** While billed each month: the day the next month is. */
  nextBilling: string | null;
  endsOn: string | null;
  problem: string | null;
}

/** Every membership, newest first, those never started too (the owners check Square for those). */
export async function listMembers(db: DbLike): Promise<MemberRow[]> {
  const rows = await db.select().from(memberships).orderBy(desc(memberships.createdAt));
  const sums = await db
    .select({ id: membershipMinutes.membershipId, total: sql<number>`coalesce(sum(${membershipMinutes.minutes}), 0)::int` })
    .from(membershipMinutes)
    .groupBy(membershipMinutes.membershipId);
  const left = new Map(sums.map((sum) => [sum.id, sum.total]));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    code: row.code,
    planName: row.planName,
    priceCents: row.priceCents,
    status: row.status,
    startedOn: row.startedOn,
    minutesLeft: left.get(row.id) ?? 0,
    nextBilling: row.status === "active" ? row.paidThrough : null,
    endsOn: row.endsOn,
    problem: row.problem,
  }));
}

/** A change to a membership's minutes, for the owners: when, how many, why, and the booking it was for. */
export interface MinutesLine {
  at: Date;
  minutes: number;
  kind: "month" | "booking" | "returned" | "correction";
  note: string;
  actor: string;
  bookingRef: string | null;
}

export interface MemberDetail extends MemberRow {
  phone: string;
  minutesPerMonth: number;
  cancelledAt: Date | null;
  lines: MinutesLine[];
  payments: MembershipPaymentView[];
}

/**
 * Every change to a membership's minutes, newest first: each month's, each booking that spent some, each given back, and
 * each correction. For the owners' member page, and the member's own account (follow-up 3's step 5: the tester's
 * finding of 2026-11-18 that the account did not list the bookings). The caller checks who may see it.
 */
export async function minutesLinesOf(db: DbLike, membershipId: string): Promise<MinutesLine[]> {
  const lines = await db
    .select({
      at: membershipMinutes.createdAt,
      minutes: membershipMinutes.minutes,
      kind: membershipMinutes.kind,
      note: membershipMinutes.note,
      actor: membershipMinutes.actor,
      bookingRef: bookings.ref,
    })
    .from(membershipMinutes)
    .leftJoin(bookings, eq(bookings.id, membershipMinutes.bookingId))
    .where(eq(membershipMinutes.membershipId, membershipId))
    .orderBy(desc(membershipMinutes.createdAt));
  return lines.map((line) => ({ ...line, bookingRef: line.bookingRef ?? null }));
}

/** One membership in full for the owners: every change to its minutes and every month paid. */
export async function memberDetail(db: DbLike, membershipId: string): Promise<MemberDetail | null> {
  if (!UUID.test(membershipId)) return null;
  const [row] = await db.select().from(memberships).where(eq(memberships.id, membershipId));
  if (!row) return null;
  const [listed] = (await listMembers(db)).filter((member) => member.id === row.id);
  return {
    ...listed,
    phone: row.phone,
    minutesPerMonth: row.minutesPerMonth,
    cancelledAt: row.cancelledAt,
    lines: await minutesLinesOf(db, row.id),
    payments: await membershipPaymentsOf(db, row.id),
  };
}

export const MINUTES_REASON_MIN = 3;
export const MINUTES_REASON_MAX = 300;
/** The most minutes added or taken away at once: 100 hours. */
const MINUTES_AT_ONCE = 6000;

export type CorrectMinutesResult = { ok: true; minutesLeft: number } | { ok: false; message: string };

/**
 * An owner adds minutes to a membership, or takes some away, with a reason, as stamps are corrected: in quarter hours,
 * and never below nothing. The change is a line of its own, which the member's account counts like any other.
 */
export async function correctMinutes(
  db: Db,
  viewer: { email: string; role: string },
  membershipId: string,
  input: { minutes: number; reason: string },
): Promise<CorrectMinutesResult> {
  if (viewer.role !== "owner") return { ok: false, message: "Only an owner can change a membership's hours." };
  if (!UUID.test(membershipId)) return { ok: false, message: "Membership not found." };
  if (!Number.isInteger(input.minutes) || input.minutes === 0 || input.minutes % 15 !== 0 || Math.abs(input.minutes) > MINUTES_AT_ONCE) {
    return { ok: false, message: "Enter the hours to add or take away in quarter hours, from 0.25 to 100, for example 1.5, or -2 to take two away." };
  }
  const reason = input.reason.replace(/\s+/g, " ").trim();
  if (reason.length < MINUTES_REASON_MIN || reason.length > MINUTES_REASON_MAX) {
    return { ok: false, message: `Say why, in ${MINUTES_REASON_MIN} to ${MINUTES_REASON_MAX} characters: the change is recorded with your reason.` };
  }
  return db.transaction(async (tx): Promise<CorrectMinutesResult> => {
    const [row] = await tx.select().from(memberships).where(eq(memberships.id, membershipId)).for("update");
    if (!row || row.status === "starting" || row.status === "failed") return { ok: false, message: "Membership not found." };
    const left = await minutesLeftOf(tx, row.id);
    if (left + input.minutes < 0) return { ok: false, message: `This membership has ${durationLabel(left)} left: no more than that can be taken away.` };
    await tx.insert(membershipMinutes).values({ membershipId: row.id, minutes: input.minutes, kind: "correction", note: reason, actor: viewer.email });
    return { ok: true, minutesLeft: left + input.minutes };
  });
}
