import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { bookings, payments, promoCodes, refunds } from "@/db/schema";
import type { Db, DbLike } from "@/db/client";
import { labelOf } from "@/lib/domain/labels";
import { formatCents } from "@/lib/domain/pricing";
import { MANUAL_PROVIDER } from "@/lib/payment-methods";
import { count, hoursInWords } from "@/lib/words";
import {
  cancellationOutcome,
  rescheduleOutcome,
  type BookingFacts,
  type CancelBlock,
  type CancelOutcome,
  type RescheduleBlock,
  type RescheduleOutcome,
} from "@/lib/domain/policy";
import { isBookingRef, tokenMatches } from "./bookings";
import { cancellationEmail, ownerHandRefundNotice, ownerRefundNotice, queueEmail, rescheduleCodeEmail } from "./email";
import { BY_CUSTOMER, BY_STUDIO, recordEvent } from "./history";
import { releaseHolds } from "./holds";
import { netCardPaidCents, paidAtStudioCents } from "./money";
import type { PaymentProvider } from "./payments";
import { issuePetCredit, petCreditOf, petFeeCentsOf } from "./pet-fee";
import { issuePromo, restorePromo } from "./promos";
import { loadSettings, type Settings } from "./settings";
import { formatInstant } from "./tz";

/**
 * Changing a booking after it was made: cancelling (with the refund the
 * policy allows, sent automatically), turning it into a reschedule code, and
 * the owner's manual refunds.
 */
type BookingRow = typeof bookings.$inferSelect;

/** Who is asking. Every function here checks it against the booking. */
export type Actor =
  | { kind: "token"; token: string } // the secret link from the confirmation email
  | { kind: "customer"; email: string } // a signed-in customer
  | { kind: "owner" };

export interface ManageDeps {
  now: Date;
  /** null when no processor is configured: refunds wait as pending. */
  payments: PaymentProvider | null;
  /** Where refund notices go. */
  ownerEmail: string | null;
  baseUrl: string;
}

function mayAct(booking: BookingRow, actor: Actor): boolean {
  switch (actor.kind) {
    case "owner":
      return true;
    case "customer":
      return booking.customerEmail === actor.email.trim().toLowerCase();
    case "token":
      return tokenMatches(booking, actor.token);
  }
}

export { netCardPaidCents } from "./money";

async function factsFor(db: DbLike, booking: BookingRow): Promise<BookingFacts> {
  const petFeeCents = await petFeeCentsOf(db, booking.id);
  return {
    status: booking.status,
    startAt: booking.startAt,
    rescheduledCount: booking.rescheduledCount,
    cardPaidCents: await netCardPaidCents(db, booking.id),
    creditAppliedCents: booking.creditAppliedCents,
    // promoDiscountCents holds whatever the code took off: for a credit code that is the credit itself.
    discountCents: booking.promoDiscountCents - booking.creditAppliedCents,
    petFeeCents,
    petCreditGiven: petFeeCents > 0 && (await petCreditOf(db, booking.id)) !== null,
    paidAtStudioCents: await paidAtStudioCents(db, booking.id),
  };
}

export interface ManageOptions {
  cancel: CancelOutcome;
  reschedule: RescheduleOutcome;
}

/**
 * The terms that apply to one booking. A photography session has to be
 * cancelled earlier than a studio rental to be refunded: the photographer has
 * set the time aside. Everything else is the same.
 */
function termsFor(booking: Pick<BookingRow, "photographerId">, settings: Settings): Settings {
  return booking.photographerId ? { ...settings, refundWindowHours: settings.photoRefundWindowHours } : settings;
}

async function manageContext(
  db: DbLike,
  ref: string,
  actor: Actor,
  now: Date,
): Promise<{ options: ManageOptions; terms: Settings } | null> {
  if (!isBookingRef(ref)) return null;
  const [booking] = await db.select().from(bookings).where(eq(bookings.ref, ref)).limit(1);
  if (!booking || !mayAct(booking, actor)) return null;
  const terms = termsFor(booking, await loadSettings(db));
  const facts = await factsFor(db, booking);
  return { options: { cancel: cancellationOutcome(facts, now, terms), reschedule: rescheduleOutcome(facts, now, terms) }, terms };
}

/** What would happen if the customer cancelled or moved this booking right now. */
export async function getManageOptions(db: DbLike, ref: string, actor: Actor, now: Date): Promise<ManageOptions | null> {
  return (await manageContext(db, ref, actor, now))?.options ?? null;
}

/** The same options in words, ready to show next to the buttons. */
export interface ManageChoices {
  cancel: { allowed: boolean; text: string };
  /** `offered` is false when the owner has switched moving off: there is then nothing to show. */
  reschedule: { allowed: boolean; text: string; offered: boolean };
}

export function describeManageOptions(options: ManageOptions, settings: Settings): ManageChoices {
  return {
    cancel: options.cancel.allowed
      ? { allowed: true, text: cancelOutcomeText(options.cancel, settings) }
      : { allowed: false, text: cancelBlockText(options.cancel.reason) },
    reschedule: options.reschedule.allowed
      ? { allowed: true, offered: true, text: rescheduleOfferText(options.reschedule, settings) }
      : {
          allowed: false,
          offered: options.reschedule.reason !== "not_offered",
          text: rescheduleBlockText(options.reschedule.reason, settings),
        },
  };
}

/** What moving a booking gives the customer, said before they confirm. */
export function rescheduleOfferText(
  outcome: Extract<RescheduleOutcome, { allowed: true }>,
  settings: Pick<Settings, "creditValidDays">,
): string {
  const discount =
    outcome.discountCents > 0
      ? ` That is what you paid plus the ${formatCents(outcome.discountCents)} your discount code took off.`
      : "";
  return `This booking will be released and you will get a code worth ${formatCents(outcome.creditCents)}, valid for ${count(settings.creditValidDays, "day")}, to book a new time.${discount} A booking made with the code cannot be refunded.`;
}

export async function getManageChoices(db: DbLike, ref: string, actor: Actor, now: Date): Promise<ManageChoices | null> {
  const context = await manageContext(db, ref, actor, now);
  return context ? describeManageOptions(context.options, context.terms) : null;
}

export function cancelBlockText(reason: CancelBlock): string {
  return reason === "already_started" ? "This booking has already started." : "This booking can no longer be changed.";
}

export function rescheduleBlockText(reason: RescheduleBlock, settings: Pick<Settings, "rescheduleCutoffHours">): string {
  switch (reason) {
    case "already_started":
      return "This booking has already started.";
    case "not_confirmed":
      return "This booking can no longer be changed.";
    case "not_offered":
      return "Bookings cannot be moved online. Please call the studio.";
    case "too_late":
      return `Bookings can be moved online until ${hoursInWords(settings.rescheduleCutoffHours)} before they start. Please call the studio.`;
    case "limit_reached":
      return "This booking was already moved and cannot be moved again online. Please call the studio.";
    case "nothing_paid":
      return "Nothing was paid for this booking, so there is no credit to move. You can cancel it and book again.";
  }
}

/** Plain words for why a cancellation refunds what it does. */
export function cancelOutcomeText(outcome: Extract<CancelOutcome, { allowed: true }>, settings: Settings): string {
  switch (outcome.why) {
    case "refund": {
      const card =
        outcome.refundCents <= 0
          ? ""
          : outcome.feeCents > 0
            ? `You will be refunded ${formatCents(outcome.refundCents)} to your card. The ${settings.refundFeePercent}% processing fee (${formatCents(outcome.feeCents)}) is not refundable.`
            : `You will be refunded ${formatCents(outcome.refundCents)} to your card.`;
      // The owner's rule: the pet fee is not refunded; when the pet does not come it becomes studio credit.
      const pet =
        outcome.creditCents > 0
          ? `The pet fee (${formatCents(outcome.creditCents)}) is not refunded to your card: it is returned as studio credit, and we email you the code.`
          : "";
      const byHand =
        outcome.byHandCents > 0
          ? `The ${formatCents(outcome.byHandCents)} you paid at the studio cannot be sent back online: please contact the studio about it.`
          : "";
      return (
        [card, pet, byHand].filter(Boolean).join(" ") ||
        // Only the pet fee was on the card, and an administrator has already returned it as credit.
        "Nothing is refunded to your card: what it paid was the pet fee, which was already returned to you as studio credit."
      );
    }
    case "paid_at_studio":
      return "This booking was paid at the studio, so no refund can be sent online. Please contact the studio about your refund.";
    case "inside_window":
      return `No refund is due, because the booking starts in less than ${hoursInWords(settings.refundWindowHours)}.`;
    case "rescheduled":
      return "No refund is due, because this booking was made with a reschedule code.";
    case "nothing_paid":
      return "Nothing was charged to a card for this booking, so there is nothing to refund.";
  }
}

// ── Refund execution ─────────────────────────────────────────────────────────

/**
 * Send one recorded refund to the processor. Safe to repeat: the refund's id
 * is the idempotency key, so the money moves at most once.
 */
export async function processRefund(db: Db, refundId: string, deps: ManageDeps): Promise<"succeeded" | "failed" | "pending"> {
  const [row] = await db
    .select({
      refund: refunds,
      providerPaymentId: payments.providerPaymentId,
      paymentId: payments.id,
      ref: bookings.ref,
      customer: bookings.customerName,
    })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .where(eq(refunds.id, refundId))
    .limit(1);
  if (!row) return "failed";
  if (row.refund.status === "succeeded") return "succeeded";
  if (!deps.payments) return "pending";

  const result = row.providerPaymentId
    ? await deps.payments.refund({
        paymentId: row.providerPaymentId,
        amountCents: row.refund.amountCents,
        idempotencyKey: row.refund.id,
        reason: row.refund.reason || `Refund for ${row.ref}`,
      })
    : ({ ok: false, message: "The payment has no processor id." } as const);

  if (result.ok) {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(refunds)
        .set({ status: "succeeded", providerRefundId: result.refundId, error: null })
        .where(and(eq(refunds.id, refundId), inArray(refunds.status, ["pending", "failed"])))
        .returning({ id: refunds.id });
      if (updated.length === 0) return; // another worker finished it first
      await tx
        .update(payments)
        .set({ refundedCents: sql`${payments.refundedCents} + ${row.refund.amountCents}` })
        .where(eq(payments.id, row.paymentId));
      if (deps.ownerEmail) {
        await queueEmail(
          tx,
          ownerRefundNotice({
            to: deps.ownerEmail,
            ref: row.ref,
            customer: row.customer,
            amountCents: row.refund.amountCents,
            automatic: row.refund.automatic,
          }),
        );
      }
    });
    return "succeeded";
  }

  // Tell the owner the first time a refund fails, not on every retry.
  const wasPending = row.refund.status === "pending";
  await db.update(refunds).set({ status: "failed", error: result.message }).where(eq(refunds.id, refundId));
  if (wasPending && deps.ownerEmail) {
    await queueEmail(
      db,
      ownerRefundNotice({
        to: deps.ownerEmail,
        ref: row.ref,
        customer: row.customer,
        amountCents: row.refund.amountCents,
        automatic: row.refund.automatic,
        failedReason: result.message,
      }),
    );
  }
  return "failed";
}

/** Retry refunds that have not gone through. Run from the scheduled task. */
export async function retryOpenRefunds(db: Db, deps: ManageDeps): Promise<{ succeeded: number; failed: number }> {
  const open = await db
    .select({ id: refunds.id })
    .from(refunds)
    .where(inArray(refunds.status, ["pending", "failed"]))
    .limit(50);
  let succeeded = 0;
  let failed = 0;
  for (const { id } of open) {
    const status = await processRefund(db, id, deps);
    if (status === "succeeded") succeeded++;
    else if (status === "failed") failed++;
  }
  return { succeeded, failed };
}

/** Record refunds of `totalCents` against a booking's payments, newest payment first. */
async function recordRefunds(
  tx: DbLike,
  bookingId: string,
  totalCents: number,
  reason: string,
  automatic: boolean,
): Promise<string[]> {
  if (totalCents <= 0) return [];
  // Only card payments made through the site: money taken at the studio cannot be sent back from here.
  const paid = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.bookingId, bookingId), eq(payments.status, "succeeded"), ne(payments.provider, MANUAL_PROVIDER)))
    .orderBy(sql`${payments.createdAt} desc`);
  const ids: string[] = [];
  let left = totalCents;
  for (const payment of paid) {
    if (left <= 0) break;
    const [{ already }] = await tx
      .select({ already: sql<number>`coalesce(sum(${refunds.amountCents}), 0)::int` })
      .from(refunds)
      .where(and(eq(refunds.paymentId, payment.id), inArray(refunds.status, ["pending", "succeeded"])));
    const amount = Math.min(left, payment.amountCents - already);
    if (amount <= 0) continue;
    const [refund] = await tx
      .insert(refunds)
      .values({ paymentId: payment.id, amountCents: amount, reason, automatic, status: "pending" })
      .returning({ id: refunds.id });
    ids.push(refund.id);
    left -= amount;
  }
  if (left > 0) throw new Error("Refund exceeds what was paid.");
  return ids;
}

// ── Cancelling ───────────────────────────────────────────────────────────────

/**
 * Give back the code a cancelled booking was made with. Returns whether a
 * code was given back.
 *
 * A discount code gets its use back. A code for an amount gets the amount
 * back when it is credit from the studio (given by hand, or a pet fee
 * returned), or when it is the studio that cancels. A customer who cancels a
 * booking made with a reschedule credit gets nothing back: a moved booking
 * cannot be refunded, which they are told before moving.
 */
async function giveCodeBack(tx: DbLike, booking: BookingRow, cancelledBy: "customer" | "studio"): Promise<boolean> {
  if (!booking.promoCodeId || booking.promoDiscountCents <= 0) return false;
  if (booking.creditAppliedCents === 0) {
    await restorePromo(tx, booking.promoCodeId, "percent", 0);
    return true;
  }
  const [code] = await tx
    .select({ source: promoCodes.source })
    .from(promoCodes)
    .where(eq(promoCodes.id, booking.promoCodeId))
    .limit(1);
  if (!code || (cancelledBy === "customer" && code.source === "reschedule")) return false;
  await restorePromo(tx, booking.promoCodeId, "amount", booking.creditAppliedCents);
  return true;
}

const CODE_BACK = "The code you used for this booking can be used again.";

export type CancelResult =
  | {
      ok: true;
      refundCents: number;
      feeCents: number;
      /** The pet fee returned as studio credit by this cancellation. 0 when there was none to return. */
      creditCents: number;
      /** sent: the processor accepted it. pending: recorded, will be retried. none: nothing was due. */
      refund: "sent" | "pending" | "none";
      message: string;
    }
  | { ok: false; status: number; code: "not_found" | CancelBlock; message: string };

/** Cancel a booking as its customer. Any refund the policy allows is sent right away. */
export async function cancelBooking(db: Db, ref: string, actor: Actor, deps: ManageDeps): Promise<CancelResult> {
  if (!isBookingRef(ref)) return { ok: false, status: 404, code: "not_found", message: "Booking not found." };
  const settings = await loadSettings(db);

  const outcome = await db.transaction(async (tx) => {
    // Lock the row so two cancellations at once cannot both refund.
    const [booking] = await tx.select().from(bookings).where(eq(bookings.ref, ref)).for("update").limit(1);
    if (!booking || !mayAct(booking, actor)) return { kind: "not_found" as const };

    const terms = termsFor(booking, settings);
    const decision = cancellationOutcome(await factsFor(tx, booking), deps.now, terms);
    if (!decision.allowed) return { kind: "blocked" as const, reason: decision.reason };

    await tx
      .update(bookings)
      .set({ status: "cancelled", cancelledAt: deps.now, cancelReason: actor.kind === "owner" ? "owner" : "customer" })
      .where(eq(bookings.id, booking.id));
    await releaseHolds(tx, booking.id);

    const codeBack = await giveCodeBack(tx, booking, actor.kind === "owner" ? "studio" : "customer");
    // The pet is not coming: its fee stays off the card and goes back as studio credit.
    const petCredit =
      decision.creditCents > 0
        ? await issuePetCredit(tx, booking, decision.creditCents, { now: deps.now, validDays: settings.creditValidDays })
        : null;
    await recordEvent(tx, {
      bookingId: booking.id,
      from: labelOf(booking),
      to: "cancelled",
      actor: actor.kind === "owner" ? BY_STUDIO : BY_CUSTOMER,
      at: deps.now,
      note: [
        decision.refundCents > 0 ? `Refund ${formatCents(decision.refundCents)}` : "No refund",
        ...(petCredit ? [`pet fee of ${formatCents(decision.creditCents)} returned as studio credit`] : []),
        ...(decision.byHandCents > 0 ? [`${formatCents(decision.byHandCents)} paid at the studio is to be refunded by hand`] : []),
      ].join("; "),
    });

    const refundIds = await recordRefunds(tx, booking.id, decision.refundCents, `Cancellation of ${booking.ref}`, true);
    const message = `${cancelOutcomeText(decision, terms)}${codeBack ? ` ${CODE_BACK}` : ""}`;
    await queueEmail(
      tx,
      cancellationEmail({
        to: booking.customerEmail,
        name: booking.customerName,
        ref: booking.ref,
        when: formatInstant(booking.startAt),
        refundCents: decision.refundCents,
        feeCents: decision.feeCents,
        note: message,
        ...(petCredit
          ? {
              petCredit: {
                code: petCredit.code,
                cents: decision.creditCents,
                expires: formatInstant(petCredit.expiresAt),
                bookUrl: `${deps.baseUrl.replace(/\/$/, "")}/book`,
              },
            }
          : {}),
      }),
    );
    // Money taken at the studio that the terms say goes back: only a person can give it back.
    if (decision.byHandCents > 0 && deps.ownerEmail) {
      await queueEmail(
        tx,
        ownerHandRefundNotice({
          to: deps.ownerEmail,
          ref: booking.ref,
          customer: booking.customerName,
          paidCents: decision.byHandCents,
          feePercent: terms.refundFeePercent,
        }),
      );
    }
    return { kind: "done" as const, decision, refundIds, message, creditCents: petCredit ? decision.creditCents : 0 };
  });

  if (outcome.kind === "not_found") return { ok: false, status: 404, code: "not_found", message: "Booking not found." };
  if (outcome.kind === "blocked") {
    return { ok: false, status: 409, code: outcome.reason, message: cancelBlockText(outcome.reason) };
  }

  let refund: "sent" | "pending" | "none" = outcome.refundIds.length === 0 ? "none" : "sent";
  for (const id of outcome.refundIds) {
    if ((await processRefund(db, id, deps)) !== "succeeded") refund = "pending";
  }
  return {
    ok: true,
    refundCents: outcome.decision.refundCents,
    feeCents: outcome.decision.feeCents,
    creditCents: outcome.creditCents,
    refund,
    message: outcome.message,
  };
}

// ── Reschedule code ──────────────────────────────────────────────────────────

export type RescheduleResult =
  | { ok: true; code: string; valueCents: number; expiresAt: Date }
  | { ok: false; status: number; code: "not_found" | RescheduleBlock; message: string };

/**
 * Release a booking and turn what was paid for it, plus what a discount code
 * took off it, into a single-customer credit code, emailed at once. The customer books the new time through the
 * normal booking screen and enters the code at checkout.
 */
export async function requestRescheduleCode(db: Db, ref: string, actor: Actor, deps: ManageDeps): Promise<RescheduleResult> {
  if (!isBookingRef(ref)) return { ok: false, status: 404, code: "not_found", message: "Booking not found." };
  const settings = await loadSettings(db);

  const outcome = await db.transaction(async (tx) => {
    const [booking] = await tx.select().from(bookings).where(eq(bookings.ref, ref)).for("update").limit(1);
    if (!booking || !mayAct(booking, actor)) return { kind: "not_found" as const };

    const decision = rescheduleOutcome(await factsFor(tx, booking), deps.now, settings);
    if (!decision.allowed) return { kind: "blocked" as const, reason: decision.reason };

    await tx
      .update(bookings)
      .set({ status: "cancelled", cancelledAt: deps.now, cancelReason: "rescheduled" })
      .where(eq(bookings.id, booking.id));
    await releaseHolds(tx, booking.id);

    await recordEvent(tx, {
      bookingId: booking.id,
      from: labelOf(booking),
      to: "cancelled",
      actor: actor.kind === "owner" ? BY_STUDIO : BY_CUSTOMER,
      at: deps.now,
      note: `Released for a reschedule code worth ${formatCents(decision.creditCents)}`,
    });

    const expiresAt = new Date(deps.now.getTime() + settings.creditValidDays * 86_400_000);
    const issued = await issuePromo(tx, {
      kind: "amount",
      value: decision.creditCents,
      source: "reschedule",
      email: booking.customerEmail,
      expiresAt,
      maxUses: 1_000_000, // limited by the money left on it, not by a count
      rescheduleGeneration: booking.rescheduledCount + 1,
      originBookingId: booking.id,
      note: `Credit from ${booking.ref}`,
    });
    if (!issued) throw new Error(`A reschedule code already exists for ${booking.ref}.`);

    await queueEmail(
      tx,
      rescheduleCodeEmail({
        to: booking.customerEmail,
        name: booking.customerName,
        ref: booking.ref,
        code: issued.code,
        valueCents: decision.creditCents,
        discountCents: decision.discountCents,
        expires: formatInstant(expiresAt),
        bookUrl: `${deps.baseUrl.replace(/\/$/, "")}/book`,
      }),
    );
    return { kind: "done" as const, code: issued.code, valueCents: decision.creditCents, expiresAt };
  });

  if (outcome.kind === "not_found") return { ok: false, status: 404, code: "not_found", message: "Booking not found." };
  if (outcome.kind === "blocked") {
    return { ok: false, status: 409, code: outcome.reason, message: rescheduleBlockText(outcome.reason, settings) };
  }
  return { ok: true, code: outcome.code, valueCents: outcome.valueCents, expiresAt: outcome.expiresAt };
}

// ── Owner actions ────────────────────────────────────────────────────────────

export type OwnerRefundResult =
  | { ok: true; refund: "sent" | "pending" | "none"; refundCents: number }
  | { ok: false; status: number; code: "not_found" | "bad_amount" | "not_cancellable"; message: string };

/**
 * The owner's cancel: any booking that has not been cancelled already, with
 * whatever refund the owner chooses, up to what the card still holds.
 */
export async function ownerCancelBooking(
  db: Db,
  ref: string,
  input: { refundCents: number },
  deps: ManageDeps,
): Promise<OwnerRefundResult> {
  if (!isBookingRef(ref)) return { ok: false, status: 404, code: "not_found", message: "Booking not found." };
  if (!Number.isInteger(input.refundCents) || input.refundCents < 0) {
    return { ok: false, status: 400, code: "bad_amount", message: "Enter a refund amount of zero or more." };
  }

  const outcome = await db.transaction(async (tx) => {
    const [booking] = await tx.select().from(bookings).where(eq(bookings.ref, ref)).for("update").limit(1);
    if (!booking) return { kind: "not_found" as const };
    if (!["confirmed", "completed", "no_show"].includes(booking.status)) return { kind: "not_cancellable" as const };
    const available = await netCardPaidCents(tx, booking.id);
    if (input.refundCents > available) return { kind: "bad_amount" as const, available };

    await tx
      .update(bookings)
      .set({ status: "cancelled", cancelledAt: deps.now, cancelReason: "owner" })
      .where(eq(bookings.id, booking.id));
    await releaseHolds(tx, booking.id);
    const refundIds = await recordRefunds(tx, booking.id, input.refundCents, `Cancelled by the studio: ${booking.ref}`, false);
    await recordEvent(tx, {
      bookingId: booking.id,
      from: labelOf(booking),
      to: "cancelled",
      actor: BY_STUDIO,
      at: deps.now,
      note: input.refundCents > 0 ? `Refund ${formatCents(input.refundCents)}` : "No refund",
    });
    // A visit that has not started was taken from the customer, so the code that paid for it goes back to them.
    // After the start the code has done its work: a later cancellation is the owner settling a refund.
    const codeBack = deps.now.getTime() < booking.startAt.getTime() && (await giveCodeBack(tx, booking, "studio"));
    await queueEmail(
      tx,
      cancellationEmail({
        to: booking.customerEmail,
        name: booking.customerName,
        ref: booking.ref,
        when: formatInstant(booking.startAt),
        refundCents: input.refundCents,
        feeCents: 0,
        note: `The studio cancelled this booking.${codeBack ? ` ${CODE_BACK}` : ""} Please contact us with any questions.`,
      }),
    );
    return { kind: "done" as const, refundIds };
  });

  if (outcome.kind === "not_found") return { ok: false, status: 404, code: "not_found", message: "Booking not found." };
  if (outcome.kind === "not_cancellable") {
    return { ok: false, status: 409, code: "not_cancellable", message: "This booking is already cancelled or was never confirmed." };
  }
  if (outcome.kind === "bad_amount") {
    return {
      ok: false,
      status: 400,
      code: "bad_amount",
      message: `At most ${formatCents(outcome.available)} can be refunded to the card for this booking.`,
    };
  }
  let refund: "sent" | "pending" | "none" = outcome.refundIds.length === 0 ? "none" : "sent";
  for (const id of outcome.refundIds) {
    if ((await processRefund(db, id, deps)) !== "succeeded") refund = "pending";
  }
  return { ok: true, refund, refundCents: input.refundCents };
}

/** A refund without cancelling, e.g. a goodwill partial refund. */
export async function ownerRefund(
  db: Db,
  ref: string,
  input: { amountCents: number; reason: string },
  deps: ManageDeps,
): Promise<OwnerRefundResult> {
  if (!isBookingRef(ref)) return { ok: false, status: 404, code: "not_found", message: "Booking not found." };
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { ok: false, status: 400, code: "bad_amount", message: "Enter a refund amount above zero." };
  }
  const outcome = await db.transaction(async (tx) => {
    const [booking] = await tx.select().from(bookings).where(eq(bookings.ref, ref)).for("update").limit(1);
    if (!booking) return { kind: "not_found" as const };
    const available = await netCardPaidCents(tx, booking.id);
    if (input.amountCents > available) return { kind: "bad_amount" as const, available };
    const refundIds = await recordRefunds(tx, booking.id, input.amountCents, input.reason.slice(0, 180) || `Refund for ${booking.ref}`, false);
    return { kind: "done" as const, refundIds };
  });
  if (outcome.kind === "not_found") return { ok: false, status: 404, code: "not_found", message: "Booking not found." };
  if (outcome.kind === "bad_amount") {
    return {
      ok: false,
      status: 400,
      code: "bad_amount",
      message: `At most ${formatCents(outcome.available)} can be refunded to the card for this booking.`,
    };
  }
  let refund: "sent" | "pending" | "none" = "sent";
  for (const id of outcome.refundIds) {
    if ((await processRefund(db, id, deps)) !== "succeeded") refund = "pending";
  }
  return { ok: true, refund, refundCents: input.amountCents };
}
