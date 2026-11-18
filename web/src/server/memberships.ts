import { randomInt } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbLike } from "@/db/client";
import { membershipMinutes, membershipPayments, membershipPlanPrices, membershipPlans, membershipPlanStudios, memberships, studios } from "@/db/schema";
import { studioCombinationError } from "@/lib/catalog-view";
import { emailField, hashToken, textField } from "./input-fields";
import { membershipCancelledEmail, membershipStartedEmail, ownerMembershipRefundNotice, queueEmail } from "./email";
import { minutesLeftOf } from "./membership-minutes";
import { monthsAfter, type PaymentProvider } from "./payments";
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
export const PLAN_MINUTES_RANGE = [30, 6000] as const;
/** At most $10,000 a month. */
export const PLAN_PRICE_MAX_CENTS = 1_000_000;

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
  customer: z.object({ name: textField(2, 120), email: emailField, phone: textField(7, 40) }),
  acceptTerms: z.literal(true),
  paymentToken: z.string().min(1).max(1000),
  /** The buying page's id for this attempt, a random UUID, sent again unchanged only when no answer came. */
  requestId: z.uuid(),
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

export type JoinProblem = "invalid_input" | "not_offered" | "payments_unavailable" | "declined" | "no_answer" | "not_set_up" | "failed_before" | "rate_limited";
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
  return { ok: true, membership: { id: row.id, code: row.code, minutesLeft, provider: row.provider } };
}
