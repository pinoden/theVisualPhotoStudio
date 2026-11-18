import { and, eq, inArray, isNotNull, isNull, max, ne, sql } from "drizzle-orm";
import { bookingEvents, bookings, payments, promoCodes, refunds } from "@/db/schema";
import type { Db, DbLike } from "@/db/client";
import { labelOf } from "@/lib/domain/labels";
import { formatCents } from "@/lib/domain/pricing";
import { MANUAL_PROVIDER } from "@/lib/payment-methods";
import { count, hoursInWords } from "@/lib/words";
import {
  afterFee,
  cancellationOutcome,
  rescheduleOutcome,
  type BookingFacts,
  type CancelBlock,
  type CancelOutcome,
  type RescheduleBlock,
  type RescheduleOutcome,
} from "@/lib/domain/policy";
import type { AuthUser } from "./auth";
import { isBookingRef, tokenMatches } from "./bookings";
import {
  cancellationEmail,
  codeRefundEmail,
  ownerHandRefundNotice,
  ownerRefundNotice,
  ownerRefundWaitingNotice,
  ownerUnseenLinkNotice,
  queueEmail,
  refundNotYetEmail,
  replaceQueuedEmail,
  rescheduleCodeEmail,
  FOREIGN_LINK,
  UNSEEN_LINK,
  type RefundState,
} from "./email";
import { BY_CUSTOMER, BY_STUDIO, BY_SYSTEM, recordEvent } from "./history";
import { releaseHolds } from "./holds";
import { heldCentsByBooking, netCardPaidCents, paidAtStudioCents } from "./money";
import {
  closePayLinkOf,
  lookAtPayLink,
  openPayLinkOf,
  PAGE_WAIT_SECONDS,
  withinSeconds,
  type LinkLook,
  type PayLinkDeps,
  type UnseenLink,
} from "./pay-links";
import type { PaymentProvider } from "./payments";
import { issuePetCredit, petCreditOf, petFeeCentsOf, petFeeReturnedCents, studioRefundableCents } from "./pet-fee";
import { issuePromo, rescheduleCodeOf, restorePromo, spendable, takeOffRescheduleCode, type RescheduleCode } from "./promos";
import { loadSettings, type Settings } from "./settings";
import { termsFor } from "./terms";
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
  const [code] = booking.promoCodeId
    ? await db.select({ source: promoCodes.source }).from(promoCodes).where(eq(promoCodes.id, booking.promoCodeId)).limit(1)
    : [];
  return {
    status: booking.status,
    startAt: booking.startAt,
    rescheduledCount: booking.rescheduledCount,
    madeWithRescheduleCode: code?.source === "reschedule",
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

async function manageContext(
  db: DbLike,
  ref: string,
  actor: Actor,
  now: Date,
): Promise<{ options: ManageOptions; terms: Settings; heldCents: number } | null> {
  if (!isBookingRef(ref)) return null;
  const [booking] = await db.select().from(bookings).where(eq(bookings.ref, ref)).limit(1);
  if (!booking || !mayAct(booking, actor)) return null;
  const terms = termsFor(booking, await loadSettings(db));
  const facts = await factsFor(db, booking);
  return {
    options: { cancel: cancellationOutcome(facts, now, terms), reschedule: rescheduleOutcome(facts, now, terms) },
    terms,
    heldCents: await heldCentsOf(db, booking.id, now),
  };
}

/** What the booking's card holds reserved, not taken yet (`heldCentsByBooking`): it is not money paid. */
async function heldCentsOf(db: DbLike, bookingId: string, now: Date): Promise<number> {
  return (await heldCentsByBooking(db, [bookingId], now)).get(bookingId) ?? 0;
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

/** `heldCents`: what the booking's card holds, not taken yet, which the words say what becomes of. */
export function describeManageOptions(options: ManageOptions, settings: Settings, heldCents = 0): ManageChoices {
  return {
    cancel: options.cancel.allowed
      ? { allowed: true, text: cancelOutcomeText(options.cancel, settings, {}, heldCents) }
      : { allowed: false, text: cancelBlockText(options.cancel.reason) },
    reschedule: options.reschedule.allowed
      ? { allowed: true, offered: true, text: rescheduleOfferText(options.reschedule, settings) }
      : {
          allowed: false,
          offered: options.reschedule.reason !== "not_offered",
          text: rescheduleBlockText(options.reschedule.reason, settings, heldCents),
        },
  };
}

/** What moving a booking gives the customer, said before they confirm. */
export function rescheduleOfferText(
  outcome: Extract<RescheduleOutcome, { allowed: true }>,
  settings: Pick<Settings, "creditValidDays">,
): string {
  // A move after the free ones: the fee is taken off the code, and the words say so, with the amount.
  const fee = outcome.feeCents > 0 ? `less the ${formatCents(outcome.feeCents)} fee for moving a booking again` : "";
  const discount =
    outcome.discountCents > 0
      ? ` That is what you paid plus the ${formatCents(outcome.discountCents)} your discount code took off${fee ? `, ${fee}` : ""}.`
      : fee
        ? ` That is what you paid ${fee}.`
        : "";
  // A free move tells the client, before they use it, that the next one will cost the fee.
  const next = outcome.feeCents === 0 && outcome.nextFeeCents > 0 ? ` Moving the new booking again would cost ${formatCents(outcome.nextFeeCents)}.` : "";
  return `This booking will be released and you will get a code worth ${formatCents(outcome.creditCents)}, valid for ${count(settings.creditValidDays, "day")}, to book a new time.${discount} A booking made with the code cannot be refunded.${next}`;
}

/** What cancelling or moving would do, in words. A page asks `noticeBookingPayments` first, so that this counts a link just paid. */
export async function getManageChoices(db: DbLike, ref: string, actor: Actor, now: Date): Promise<ManageChoices | null> {
  const context = await manageContext(db, ref, actor, now);
  return context ? describeManageOptions(context.options, context.terms, context.heldCents) : null;
}

const NOT_CHANGEABLE = "This booking can no longer be changed.";

/**
 * A booking that stopped being confirmed while the client's page was open,
 * said as what became of it: their own request did nothing.
 */
function endedText(booking: { status: string; cancelReason: string | null }): string {
  const look = " Reload the page to see it as it is now.";
  switch (booking.status) {
    case "cancelled":
      return booking.cancelReason === "rescheduled"
        ? `This booking was released for a reschedule code meanwhile, so nothing more was done.${look}`
        : `This booking was cancelled meanwhile, so nothing more was done.${look}`;
    case "completed":
      return "This visit has taken place, so the booking can no longer be changed online.";
    case "no_show":
      return "This booking was marked as missed, so it can no longer be changed online. Please call the studio.";
    default:
      return `${NOT_CHANGEABLE}${look}`;
  }
}

export function cancelBlockText(reason: CancelBlock): string {
  return reason === "already_started" ? "This booking has already started." : NOT_CHANGEABLE;
}

export function rescheduleBlockText(
  reason: RescheduleBlock,
  settings: Pick<Settings, "rescheduleCutoffHours" | "rescheduleFeeCents">,
  heldCents = 0,
): string {
  switch (reason) {
    case "already_started":
      return "This booking has already started.";
    case "not_confirmed":
      return NOT_CHANGEABLE;
    case "not_offered":
      return "Bookings cannot be moved online. Please call the studio.";
    case "too_late":
      return `Bookings can be moved online until ${hoursInWords(settings.rescheduleCutoffHours)} before they start. Please call the studio.`;
    case "limit_reached":
      return "This booking was already moved and cannot be moved again online. Please call the studio.";
    case "fee_not_covered":
      return `Moving a booking again costs ${formatCents(settings.rescheduleFeeCents)}, and this booking is not worth more than that, so no credit would be left to move. Please call the studio.`;
    case "nothing_paid":
      // The card holds the amount, and taking it did not go through yet: it is not money paid.
      return heldCents > 0
        ? `Nothing was charged for this booking yet: the ${formatCents(heldCents)} your card holds for it has not been taken, so there is no credit to move. You can cancel it, which releases that amount, and book again.`
        : "Nothing was paid for this booking, so there is no credit to move. You can cancel it and book again.";
  }
}

/**
 * What a cancellation leaves to the studio to refund by hand, of what was
 * paid at the studio: the amount after the fee. A fee of 100% keeps it all,
 * and then there is nothing to ask the studio for.
 */
function handRefundSentence(byHandCents: number, settings: Pick<Settings, "refundFeePercent">): string {
  const back = afterFee(byHandCents, settings.refundFeePercent);
  if (back <= 0) {
    return `Of what you paid at the studio (${formatCents(byHandCents)}), nothing is refunded: the ${settings.refundFeePercent}% processing fee is not refundable.`;
  }
  const fee = back < byHandCents ? ` (${formatCents(byHandCents)}, less the ${settings.refundFeePercent}% processing fee)` : "";
  return `Of what you paid at the studio, ${formatCents(back)} is refunded${fee}: that cannot be sent back online, so please contact the studio about it.`;
}

/**
 * The pet fee coming back as credit: the whole fee, or part of it, when part
 * was refunded to the card already or only part of it was paid. A booking
 * with no card payment is not told about a card.
 */
function petCreditSentence(outcome: Extract<CancelOutcome, { allowed: true }>): string {
  const card = outcome.why === "paid_at_studio" ? "" : " to your card";
  return outcome.petFeeCents === undefined || outcome.creditCents === outcome.petFeeCents
    ? `The pet fee (${formatCents(outcome.creditCents)}) is not refunded${card}: it is returned as studio credit, and we email you the code.`
    : `Of the pet fee, ${formatCents(outcome.creditCents)} is returned to you as studio credit, not${card || " refunded"}, and we email you the code.`;
}

/**
 * Plain words for why a cancellation refunds what it does. `without` leaves
 * out what an email says in words of its own: the card refund, which it says
 * once it knows whether the refund went through, and the pet fee's credit,
 * which it gives with its code.
 */
export function cancelOutcomeText(
  outcome: Extract<CancelOutcome, { allowed: true }>,
  settings: Settings,
  without: { card?: boolean; pet?: boolean } = {},
  /** What the booking's card holds, not taken yet: released by a cancellation, which says so. */
  heldCents = 0,
): string {
  const pet = without.pet || outcome.creditCents <= 0 ? "" : petCreditSentence(outcome);
  const byHand = outcome.byHandCents > 0 ? handRefundSentence(outcome.byHandCents, settings) : "";
  switch (outcome.why) {
    case "refund": {
      // Only the pet fee was on the card, and an administrator has already returned it as credit.
      if (outcome.refundCents <= 0 && outcome.feeCents <= 0 && outcome.creditCents <= 0 && outcome.byHandCents <= 0) {
        return "Nothing is refunded to your card: what it paid was the pet fee, which was already returned to you as studio credit.";
      }
      const fee = `The ${settings.refundFeePercent}% processing fee (${formatCents(outcome.feeCents)}) is not refundable.`;
      const card =
        without.card || (outcome.refundCents <= 0 && outcome.feeCents <= 0)
          ? ""
          : outcome.refundCents <= 0
            ? // A fee of 100%: the card keeps nothing to give back.
              `Nothing is refunded to your card. ${fee}`
            : outcome.feeCents > 0
              ? `You will be refunded ${formatCents(outcome.refundCents)} to your card. ${fee}`
              : `You will be refunded ${formatCents(outcome.refundCents)} to your card.`;
      // The owner's rule: the pet fee is not refunded; when the pet does not come it becomes studio credit.
      return [card, pet, byHand].filter(Boolean).join(" ");
    }
    case "paid_at_studio": {
      if (outcome.creditCents <= 0 && outcome.byHandCents <= 0) {
        return "Nothing is to be refunded: what was paid was the pet fee, which was already returned to you as studio credit.";
      }
      return [byHand, pet].filter(Boolean).join(" ");
    }
    case "inside_window":
      return `No refund is due, because the booking starts in less than ${hoursInWords(settings.refundWindowHours)}.`;
    case "rescheduled":
      return "No refund is due, because this booking was made with a reschedule code.";
    case "moved":
      return "No refund is due, because this booking was moved at your request: a moved booking is not refunded.";
    case "nothing_paid":
      return heldCents > 0
        ? `Nothing was charged to your card for this booking, so there is nothing to refund: the ${formatCents(heldCents)} it holds for it is released.`
        : "Nothing was charged to a card for this booking, so there is nothing to refund.";
  }
}

// ── Refund execution ─────────────────────────────────────────────────────────

/** The processor's own words, as a sentence of their own: with one full stop at the end, not two. */
function asSentence(words: string): string {
  const text = words.trim() || "No reason was given.";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * Send one recorded refund to the processor. Safe to repeat: the refund's id
 * is the idempotency key, so the money moves at most once.
 */
export async function processRefund(db: Db, refundId: string, deps: ManageDeps): Promise<"succeeded" | "failed" | "waiting"> {
  const [row] = await db
    .select({
      refund: refunds,
      providerPaymentId: payments.providerPaymentId,
      provider: payments.provider,
      paymentId: payments.id,
      ref: bookings.ref,
      customer: bookings.customerName,
      bookingId: bookings.id,
      bookingStatus: bookings.status,
      bookingLabel: bookings.label,
    })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .where(eq(refunds.id, refundId))
    .limit(1);
  if (!row) return "failed";
  if (row.refund.status === "succeeded") return "succeeded";
  if (!deps.payments) return waitForProcessor(db, row, "No card processor is set up now, so the refund waits: it is sent once one is.", deps);

  // A payment taken through another processor than the one set up now is unknown to this one, which is never asked
  // about it: its refund waits, untouched, for that processor to be set up again. (A database never holds test mode's
  // payments beside the live account's: src/server/test-mode.ts.) Not failed: an owner told to refund it by hand could
  // see it refunded a second time once the right processor is back.
  if (row.provider !== deps.payments.name) {
    return waitForProcessor(
      db,
      row,
      "Its payment was taken through another card processor, or Square account, than the one set up now, so the refund waits: it is sent once that one is set up again.",
      deps,
    );
  }
  const result = row.providerPaymentId
    ? await deps.payments.refund({
        paymentId: row.providerPaymentId,
        amountCents: row.refund.amountCents,
        idempotencyKey: row.refund.id,
        reason: row.refund.reason || `Refund for ${row.ref}`,
      })
    : ({ ok: false, message: "The payment has no processor id." } as const);

  const label = labelOf({ status: row.bookingStatus, label: row.bookingLabel });
  if (result.ok) {
    await db.transaction(async (tx) => {
      // Dated when the processor took it: a refund that went through when it was tried again belongs to that day. Made
      // from failed (it was told as not gone through, perhaps by an attempt beside this one) or from waiting, as it
      // stands now, not as it was read.
      const made = { status: "succeeded" as const, providerRefundId: result.refundId, error: null, settledAt: result.settled ? deps.now : null, createdAt: deps.now };
      const fromFailed = await tx
        .update(refunds)
        .set(made)
        .where(and(eq(refunds.id, refundId), eq(refunds.status, "failed")))
        .returning({ id: refunds.id });
      const fromWaiting =
        fromFailed.length > 0
          ? []
          : await tx
              .update(refunds)
              .set(made)
              .where(and(eq(refunds.id, refundId), eq(refunds.status, "pending")))
              .returning({ id: refunds.id });
      if (fromFailed.length + fromWaiting.length === 0) return; // another worker finished it first
      await tx
        .update(payments)
        .set({ refundedCents: sql`${payments.refundedCents} + ${row.refund.amountCents}` })
        .where(eq(payments.id, row.paymentId));
      // Its history said it did not go through: it says now that it did, after that line, whatever clock the attempt
      // that wrote it had (the scheduled task's and a request's are not the same).
      if (fromFailed.length > 0) {
        const [last] = await tx.select({ at: max(bookingEvents.at) }).from(bookingEvents).where(eq(bookingEvents.bookingId, row.bookingId));
        await recordEvent(tx, {
          bookingId: row.bookingId,
          from: label,
          to: label,
          actor: BY_SYSTEM,
          at: last?.at && last.at.getTime() >= deps.now.getTime() ? new Date(last.at.getTime() + 1) : deps.now,
          note: `The refund of ${formatCents(row.refund.amountCents)} went through when it was tried again`,
        });
      }
      if (deps.ownerEmail) {
        await queueEmail(
          tx,
          ownerRefundNotice({
            to: deps.ownerEmail,
            ref: row.ref,
            customer: row.customer,
            amountCents: row.refund.amountCents,
            automatic: row.refund.automatic,
            reason: row.refund.reason,
          }),
        );
      }
    });
    return "succeeded";
  }

  // Tell the owner the first time a refund fails, not on every retry: only the attempt that turns it from waiting to
  // failed does, so two attempts at once (the scheduled task beside the cancellation) tell once. Only a refund still
  // open becomes failed: one an owner recorded as made in Square while the processor was answering stays made. One
  // transaction: an attempt that goes through meanwhile waits for it, and its own line then comes after this one.
  return db.transaction(async (tx): Promise<"succeeded" | "failed"> => {
    const marked = await tx
      .update(refunds)
      .set({ status: "failed", error: result.message })
      .where(and(eq(refunds.id, refundId), eq(refunds.status, "pending")))
      .returning({ id: refunds.id });
    if (marked.length === 0) {
      const still = await tx
        .update(refunds)
        .set({ error: result.message })
        .where(and(eq(refunds.id, refundId), eq(refunds.status, "failed")))
        .returning({ id: refunds.id });
      // Made meanwhile, by another attempt or by hand in Square: it is not a failure.
      if (still.length === 0) {
        const [now] = await tx.select({ status: refunds.status }).from(refunds).where(eq(refunds.id, refundId)).limit(1);
        if (now?.status === "succeeded") return "succeeded";
      }
      return "failed";
    }
    // The booking's history says so, the first time: whatever happens to the refund later then reads in order.
    await recordEvent(tx, {
      bookingId: row.bookingId,
      from: label,
      to: label,
      actor: BY_SYSTEM,
      at: deps.now,
      note: `The refund of ${formatCents(row.refund.amountCents)} did not go through, and is tried again. The processor's answer: ${asSentence(result.message)}`,
    });
    if (deps.ownerEmail) {
      await queueEmail(
        tx,
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
  });
}

/**
 * A refund that cannot be sent with the processor set up now waits for the
 * right one, untouched (`processRefund`). It says why, where the owner sees
 * refunds that have not gone through, and the owner is emailed, once: the
 * client is told the studio knows.
 */
async function waitForProcessor(
  db: Db,
  row: { refund: { id: string; amountCents: number; error: string | null }; ref: string; customer: string },
  reason: string,
  deps: ManageDeps,
): Promise<"waiting"> {
  if (row.refund.error === reason) return "waiting";
  await db.transaction(async (tx) => {
    const marked = await tx
      .update(refunds)
      .set({ error: reason })
      .where(and(eq(refunds.id, row.refund.id), eq(refunds.status, "pending")))
      .returning({ id: refunds.id });
    if (marked.length > 0 && deps.ownerEmail) {
      await queueEmail(tx, ownerRefundWaitingNotice({ to: deps.ownerEmail, ref: row.ref, customer: row.customer, amountCents: row.refund.amountCents, reason }));
    }
  });
  return "waiting";
}

/**
 * Where the card refunds of one change stand together: `sent` when the
 * processor accepted each, `pending` when one did not go through (it is tried
 * again by the scheduled task), `waiting` when one waits for the card
 * processor its payment was taken through (it is sent once that one is set
 * up), `none` when nothing was due to a card.
 */
export type RefundsState = "sent" | "pending" | "waiting" | "none";

/** Send the refunds recorded for one change (`processRefund`), and say where they stand together. */
async function sendRefunds(db: Db, refundIds: string[], deps: ManageDeps): Promise<RefundsState> {
  if (refundIds.length === 0) return "none";
  let state: RefundsState = "sent";
  for (const id of refundIds) {
    const status = await processRefund(db, id, deps);
    if (status === "failed") state = "pending";
    else if (status === "waiting" && state === "sent") state = "waiting";
  }
  return state;
}

/**
 * Retry refunds that have not gone through. Run from the scheduled task. Only
 * refunds of payments the processor set up now took, and that stand: one of
 * another processor's waits for it, and keeps none of the others waiting.
 */
export async function retryOpenRefunds(db: Db, deps: ManageDeps): Promise<{ succeeded: number; failed: number }> {
  if (!deps.payments) return { succeeded: 0, failed: 0 };
  const open = await db
    .select({ id: refunds.id })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .where(and(inArray(refunds.status, ["pending", "failed"]), eq(payments.provider, deps.payments.name), eq(payments.status, "succeeded")))
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

/**
 * Ask the processor about the refunds it accepted without completing them.
 * One that completed is marked so. One it rejected after all becomes failed:
 * the money did not go back, so the payment's refunded amount is taken down
 * again and the owner is told, as when a refund fails at once; it is then
 * retried with the others (`retryOpenRefunds`). Run from the scheduled task.
 */
export async function checkUnsettledRefunds(db: Db, deps: ManageDeps): Promise<{ settled: number; rejected: number }> {
  if (!deps.payments) return { settled: 0, rejected: 0 };
  const open = await db
    .select({
      refund: refunds,
      paymentId: payments.id,
      ref: bookings.ref,
      customer: bookings.customerName,
      bookingId: bookings.id,
      bookingStatus: bookings.status,
      bookingLabel: bookings.label,
    })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    // Only the processor set up now is asked, about its own refunds: another's would not know them.
    .where(
      and(eq(refunds.status, "succeeded"), isNull(refunds.settledAt), isNotNull(refunds.providerRefundId), eq(payments.provider, deps.payments.name)),
    )
    .limit(50);
  let settled = 0;
  let rejected = 0;
  for (const row of open) {
    const answer = await deps.payments.refundState(row.refund.providerRefundId!);
    if (answer.state === "completed") {
      await db.update(refunds).set({ settledAt: deps.now }).where(and(eq(refunds.id, row.refund.id), isNull(refunds.settledAt)));
      settled++;
    } else if (answer.state === "rejected") {
      const done = await db.transaction(async (tx) => {
        const updated = await tx
          .update(refunds)
          .set({ status: "failed", error: answer.message })
          .where(and(eq(refunds.id, row.refund.id), eq(refunds.status, "succeeded")))
          .returning({ id: refunds.id });
        if (updated.length === 0) return false; // another worker got there first
        await tx
          .update(payments)
          .set({ refundedCents: sql`${payments.refundedCents} - ${row.refund.amountCents}` })
          .where(eq(payments.id, row.paymentId));
        const label = labelOf({ status: row.bookingStatus, label: row.bookingLabel });
        await recordEvent(tx, {
          bookingId: row.bookingId,
          from: label,
          to: label,
          actor: BY_SYSTEM,
          at: deps.now,
          note: `Square accepted the refund of ${formatCents(row.refund.amountCents)}, then did not make it, and it is tried again. Its answer: ${asSentence(answer.message)}`,
        });
        if (deps.ownerEmail) {
          await queueEmail(
            tx,
            ownerRefundNotice({
              to: deps.ownerEmail,
              ref: row.ref,
              customer: row.customer,
              amountCents: row.refund.amountCents,
              automatic: row.refund.automatic,
              failedReason: `Square accepted the refund, then did not make it. Its answer: ${asSentence(answer.message)}`,
            }),
          );
        }
        return true;
      });
      if (done) rejected++;
    }
  }
  return { settled, rejected };
}

export type HandRefundResult = { ok: true } | { ok: false; reason: "forbidden" | "not_found" | "not_failed"; message: string };

/**
 * An owner refunded a payment by hand in Square after the site could not:
 * Square answers a refund it rejected the same way each time it is tried
 * again. The refund the site recorded then counts as made. It is no longer
 * tried again or listed as a problem, the payment's refunded amount includes
 * it, receipts show it, and the booking's history says who recorded it.
 *
 * Only for a refund that failed. One still waiting may yet be sent by the
 * site, and the money would then go back twice.
 */
export async function recordRefundMadeInSquare(db: Db, viewer: AuthUser, refundId: string, now: Date): Promise<HandRefundResult> {
  if (viewer.role !== "owner") return { ok: false, reason: "forbidden", message: "Only an owner can record a refund made in Square." };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(refundId)) {
    return { ok: false, reason: "not_found", message: "That refund was not found." };
  }
  return db.transaction(async (tx): Promise<HandRefundResult> => {
    // Locked, so the scheduled task cannot send it while it is recorded as made.
    const [refund] = await tx.select().from(refunds).where(eq(refunds.id, refundId)).for("update").limit(1);
    if (!refund) return { ok: false, reason: "not_found", message: "That refund was not found." };
    if (refund.status !== "failed") {
      return {
        ok: false,
        reason: "not_failed",
        message: refund.status === "succeeded" ? "That refund is made already." : "That refund has not failed: the site may still send it. Only a refund that failed can be recorded as made in Square.",
      };
    }
    const [payment] = await tx.select().from(payments).where(eq(payments.id, refund.paymentId)).for("update").limit(1);
    if (!payment || payment.refundedCents + refund.amountCents > payment.amountCents) {
      return { ok: false, reason: "not_failed", message: "That is more than the payment still holds: it cannot be recorded as made." };
    }
    // Made now, by hand: its date on receipts and in the year's statement is today's.
    await tx.update(refunds).set({ status: "succeeded", settledAt: now, createdAt: now, error: null }).where(eq(refunds.id, refund.id));
    await tx
      .update(payments)
      .set({ refundedCents: sql`${payments.refundedCents} + ${refund.amountCents}` })
      .where(eq(payments.id, refund.paymentId));
    const [booking] = await tx
      .select()
      .from(bookings)
      .innerJoin(payments, eq(payments.bookingId, bookings.id))
      .where(eq(payments.id, refund.paymentId))
      .limit(1);
    if (booking) {
      const label = labelOf(booking.bookings);
      await recordEvent(tx, {
        bookingId: booking.bookings.id,
        from: label,
        to: label,
        actor: viewer.email,
        at: now,
        note: `A refund of ${formatCents(refund.amountCents)} that the site could not make was made by hand in Square`,
      });
    }
    return { ok: true };
  });
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
      // A refund that failed is owed, and still counts: it is tried again until it is made.
      .where(and(eq(refunds.paymentId, payment.id), inArray(refunds.status, ["pending", "succeeded", "failed"])));
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

/** When what a cancellation or a move would do has changed since the client was told: they are shown it as it is now. */
const LOOK_AGAIN = "What this would do has changed since the page was opened. Here it is as it is now: please look at it again.";

/**
 * A booking ends while the processor cannot say whether its payment link was
 * paid. It ends all the same: a client who asks in time is never kept waiting
 * past a deadline, and a link the processor no longer knows would keep them
 * waiting for good. A payment through the link that is seen later is refunded
 * in full, as one that arrives after the booking ended always is; the client
 * is told so (`UNSEEN_LINK`), the history says so, and the owners are told to
 * look in Square (`ownerUnseenLinkNotice`). A link of another processor than
 * the one set up now can never be asked about: the client is asked to say
 * whether they paid it (`FOREIGN_LINK`). Answers what the client is told, or
 * null when there was no open link.
 */
async function noteUnseenLink(tx: DbLike, booking: BookingRow, ended: "cancelled" | "released", deps: ManageDeps): Promise<string | null> {
  const link = await openPayLinkOf(tx, booking.id);
  if (!link) return null;
  // Asked of a processor that could not say; of none, none being set up; or of another than the link's own.
  const kind = !deps.payments ? "none" : link.provider === deps.payments.name ? "unseen" : "other";
  await recordEvent(tx, {
    bookingId: booking.id,
    from: "cancelled",
    to: "cancelled",
    actor: BY_SYSTEM,
    at: deps.now,
    note:
      kind === "other"
        ? `The payment link for ${formatCents(link.amountCents)} was made by another card processor than the one set up now: the site cannot ask whether it was paid`
        : kind === "none"
          ? `No card processor was set up, so the site could not ask whether the payment link for ${formatCents(link.amountCents)} was paid`
          : `The card processor could not say whether the payment link for ${formatCents(link.amountCents)} was paid: a payment through it is refunded in full once it is seen`,
  });
  if (deps.ownerEmail) {
    await queueEmail(
      tx,
      ownerUnseenLinkNotice({ to: deps.ownerEmail, ref: booking.ref, customer: booking.customerName, linkCents: link.amountCents, ended, kind }),
    );
  }
  return kind === "unseen" ? UNSEEN_LINK : FOREIGN_LINK;
}

/**
 * A payment link paid that the site has not seen yet is recorded before a
 * booking stops being active, and before its page tells the client what
 * cancelling or moving would do, so that both count that money
 * (`noticePaidLink`). Only for someone who may act on the booking. Answers
 * what the processor said: `unanswered` when it could not say.
 */
async function countPaidLink(db: Db, ref: string, actor: Actor | null, deps: PayLinkDeps): Promise<LinkLook> {
  if (!isBookingRef(ref)) return "none";
  const [booking] = await db.select().from(bookings).where(eq(bookings.ref, ref)).limit(1);
  if (!booking || (actor !== null && !mayAct(booking, actor))) return "none";
  return lookAtPayLink(db, booking, deps);
}

/**
 * For the booking's own page, before it is drawn: a payment link just paid is
 * recorded, and the link of a booking no longer active is withdrawn
 * (`lookAtPayLink`). The page does not wait more than a few seconds for a slow
 * processor: what the client then presses asks again, and waits for the
 * answer. `afterward` is handed the work, to keep it going after the response
 * and to deliver the mail it queues (`finishAfterResponse`).
 */
export async function noticeBookingPayments(
  db: Db,
  ref: string,
  actor: Actor,
  deps: PayLinkDeps,
  afterward?: (work: Promise<unknown>) => void,
): Promise<UnseenLink> {
  const look = countPaidLink(db, ref, actor, deps).catch((error: unknown): LinkLook => {
    console.error("Could not look at the payment link of booking", ref, error);
    return "unanswered";
  });
  afterward?.(look);
  // The booking has an open link that nobody could say anything about in time: the page says that what it shows may
  // not count a payment made through it yet, or, for another processor's, that the client should say if they paid it.
  const answer = await withinSeconds(PAGE_WAIT_SECONDS, look);
  return answer === undefined || answer === "unanswered" ? "unanswered" : answer === "foreign" ? "foreign" : null;
}

/** A cancellation email before it is known whether its card refund goes through. */
type CancellationNotice = Omit<Parameters<typeof cancellationEmail>[0], "refund"> & { refund?: { cents: number; feeCents: number } };

const noticeEmail = ({ refund, ...rest }: CancellationNotice, state: RefundState) =>
  cancellationEmail({ ...rest, ...(refund ? { refund: { ...refund, state } } : {}) });

/**
 * The cancellation's card refund did not go through. Its email, queued with
 * the cancellation, said it was on its way: it says now that it has not
 * reached the card yet. One that has already left gets a second email that
 * says so.
 */
async function refundNotSent(db: Db, emailId: string, notice: CancellationNotice): Promise<void> {
  if (!notice.refund) return;
  if (await replaceQueuedEmail(db, emailId, noticeEmail(notice, "not_yet"))) return;
  await queueEmail(db, refundNotYetEmail({ to: notice.to, name: notice.name, ref: notice.ref, cents: notice.refund.cents, feeCents: notice.refund.feeCents }));
}

export type CancelResult =
  | {
      ok: true;
      refundCents: number;
      feeCents: number;
      /** The pet fee returned as studio credit by this cancellation. 0 when there was none to return. */
      creditCents: number;
      /** Where the card refund stands (`RefundsState`). */
      refund: RefundsState;
      message: string;
    }
  | { ok: false; status: number; code: "not_found" | "changed" | CancelBlock; message: string };

/**
 * Cancel a booking as its customer. Any refund the policy allows is sent right
 * away. `seen` is what the client was told the cancellation does: when it would
 * do something else now (a payment arrived, the refund window passed), nothing
 * is done and they are asked to look again. When the processor cannot say
 * whether the booking's payment link was paid, it is cancelled all the same
 * (`noteUnseenLink`).
 */
export async function cancelBooking(db: Db, ref: string, actor: Actor, deps: ManageDeps, seen?: string): Promise<CancelResult> {
  if (!isBookingRef(ref)) return { ok: false, status: 404, code: "not_found", message: "Booking not found." };
  const settings = await loadSettings(db);
  const look = await countPaidLink(db, ref, actor, deps);
  const unseen = look === "unanswered" || look === "foreign";

  const outcome = await db.transaction(async (tx) => {
    // Lock the row so two cancellations at once cannot both refund.
    const [booking] = await tx.select().from(bookings).where(eq(bookings.ref, ref)).for("update").limit(1);
    if (!booking || !mayAct(booking, actor)) return { kind: "not_found" as const };

    const terms = termsFor(booking, settings);
    const decision = cancellationOutcome(await factsFor(tx, booking), deps.now, terms);
    if (!decision.allowed) return { kind: "blocked" as const, reason: decision.reason, booking: { status: booking.status, cancelReason: booking.cancelReason } };
    // What the card holds, not taken yet: nothing was charged, and the cancellation says it is released.
    const heldCents = await heldCentsOf(tx, booking.id, deps.now);
    if (seen !== undefined && seen !== cancelOutcomeText(decision, terms, {}, heldCents)) return { kind: "changed" as const };

    await tx
      .update(bookings)
      .set({ status: "cancelled", cancelledAt: deps.now, cancelReason: actor.kind === "owner" ? "owner" : "customer" })
      .where(eq(bookings.id, booking.id));
    await releaseHolds(tx, booking.id);

    const codeBack = await giveCodeBack(tx, booking, actor.kind === "owner" ? "studio" : "customer");
    // The pet is not coming: its fee stays off the card and goes back as studio credit.
    const petCredit =
      decision.creditCents > 0
        ? await issuePetCredit(tx, booking, decision.creditCents, { now: deps.now, validDays: terms.creditValidDays })
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
        ...(decision.byHandCents > 0
          ? [
              afterFee(decision.byHandCents, terms.refundFeePercent) > 0
                ? `${formatCents(afterFee(decision.byHandCents, terms.refundFeePercent))} of what was paid at the studio is to be refunded by hand`
                : `nothing of the ${formatCents(decision.byHandCents)} paid at the studio is refunded (the ${terms.refundFeePercent}% fee)`,
            ]
          : []),
      ].join("; "),
    });

    const refundIds = await recordRefunds(tx, booking.id, decision.refundCents, `Cancellation of ${booking.ref}`, true);
    const unseenNote = unseen ? await noteUnseenLink(tx, booking, "cancelled", deps) : null;
    const message = `${cancelOutcomeText(decision, terms, {}, heldCents)}${codeBack ? ` ${CODE_BACK}` : ""}${unseenNote ? ` ${unseenNote}` : ""}`;
    // The whole outcome. The card refund is said as sent: if it does not go through, the email is put right (`refundNotSent`).
    const email: CancellationNotice = {
      to: booking.customerEmail,
      name: booking.customerName,
      ref: booking.ref,
      when: formatInstant(booking.startAt),
      ...(decision.refundCents > 0 ? { refund: { cents: decision.refundCents, feeCents: decision.feeCents } } : {}),
      lines: [
        cancelOutcomeText(decision, terms, { card: decision.refundCents > 0, pet: true }, heldCents),
        ...(codeBack ? [CODE_BACK] : []),
        ...(unseenNote ? [unseenNote] : []),
      ].filter(Boolean),
      ...(petCredit
        ? {
            petCredit: {
              code: petCredit.code,
              cents: decision.creditCents,
              feeCents: decision.petFeeCents ?? decision.creditCents,
              card: decision.why !== "paid_at_studio",
              expires: formatInstant(petCredit.expiresAt),
              bookUrl: `${deps.baseUrl.replace(/\/$/, "")}/book`,
            },
          }
        : {}),
    };
    const emailId = await queueEmail(tx, noticeEmail(email, "sent"));
    // Money taken at the studio that the terms say goes back: only a person can give it back.
    if (afterFee(decision.byHandCents, terms.refundFeePercent) > 0 && deps.ownerEmail) {
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
    return { kind: "done" as const, decision, refundIds, message, creditCents: petCredit ? decision.creditCents : 0, bookingId: booking.id, email, emailId };
  });

  if (outcome.kind === "not_found") return { ok: false, status: 404, code: "not_found", message: "Booking not found." };
  if (outcome.kind === "blocked") {
    const message = outcome.reason === "not_confirmed" ? endedText(outcome.booking) : cancelBlockText(outcome.reason);
    return { ok: false, status: 409, code: outcome.reason, message };
  }
  if (outcome.kind === "changed") return { ok: false, status: 409, code: "changed", message: LOOK_AGAIN };

  // The money first: a host that cuts a slow request short leaves the link to the scheduled task, not the refund.
  const refund = await sendRefunds(db, outcome.refundIds, deps);
  if (refund === "pending" || refund === "waiting") await refundNotSent(db, outcome.emailId, outcome.email);
  // A payment link still open for the booking is withdrawn, so that nobody pays for it now; not when the processor has
  // just failed to answer about it, which would only keep the client waiting again: the scheduled task does it.
  if (!unseen) await closePayLinkOf(db, outcome.bookingId, deps);
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
  | {
      ok: true;
      code: string;
      bookPath: "/book" | "/book/photography";
      valueCents: number;
      expiresAt: Date;
      /** The processor could not say whether the booking's payment link was paid. */
      unseenLink: boolean;
      /** What the client is told of it (`noteUnseenLink`), or null. */
      unseenNote: string | null;
    }
  | { ok: false; status: number; code: "not_found" | "changed" | RescheduleBlock; message: string };

/**
 * Release a booking and turn what was paid for it, plus what a discount code
 * took off it, into a single-customer credit code, emailed at once. The customer books the new time through the
 * normal booking screen and enters the code at checkout. When the processor
 * cannot say whether the booking's payment link was paid, it is released all
 * the same (`noteUnseenLink`).
 */
export async function requestRescheduleCode(db: Db, ref: string, actor: Actor, deps: ManageDeps, seen?: string): Promise<RescheduleResult> {
  if (!isBookingRef(ref)) return { ok: false, status: 404, code: "not_found", message: "Booking not found." };
  const settings = await loadSettings(db);
  const look = await countPaidLink(db, ref, actor, deps);
  const unseen = look === "unanswered" || look === "foreign";

  const outcome = await db.transaction(async (tx) => {
    const [booking] = await tx.select().from(bookings).where(eq(bookings.ref, ref)).for("update").limit(1);
    if (!booking || !mayAct(booking, actor)) return { kind: "not_found" as const };

    // The terms the booking was made under: its moving rules, and how long the code it gives stays valid.
    const terms = termsFor(booking, settings);
    const decision = rescheduleOutcome(await factsFor(tx, booking), deps.now, terms);
    if (!decision.allowed) {
      return {
        kind: "blocked" as const,
        reason: decision.reason,
        booking: { status: booking.status, cancelReason: booking.cancelReason },
        heldCents: await heldCentsOf(tx, booking.id, deps.now),
        terms,
      };
    }
    if (seen !== undefined && seen !== rescheduleOfferText(decision, terms)) return { kind: "changed" as const };

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
      note:
        decision.feeCents > 0
          ? `Released for a reschedule code worth ${formatCents(decision.creditCents)}, after the ${formatCents(decision.feeCents)} fee for moving a booking again`
          : `Released for a reschedule code worth ${formatCents(decision.creditCents)}`,
    });

    const expiresAt = new Date(deps.now.getTime() + terms.creditValidDays * 86_400_000);
    const photographyOnly = booking.photographerId !== null;
    const bookPath: "/book" | "/book/photography" = photographyOnly ? "/book/photography" : "/book";
    const issued = await issuePromo(tx, {
      kind: "amount",
      value: decision.creditCents,
      source: "reschedule",
      photographyOnly,
      email: booking.customerEmail,
      expiresAt,
      maxUses: 1_000_000, // limited by the money left on it, not by a count
      rescheduleGeneration: booking.rescheduledCount + 1,
      originBookingId: booking.id,
      note: `Credit from ${booking.ref}`,
      issuedAt: deps.now,
    });
    if (!issued) throw new Error(`A reschedule code already exists for ${booking.ref}.`);
    const unseenNote = unseen ? await noteUnseenLink(tx, booking, "released", deps) : null;

    await queueEmail(
      tx,
      rescheduleCodeEmail({
        to: booking.customerEmail,
        name: booking.customerName,
        ref: booking.ref,
        code: issued.code,
        valueCents: decision.creditCents,
        discountCents: decision.discountCents,
        feeCents: decision.feeCents,
        expires: formatInstant(expiresAt),
        bookUrl: `${deps.baseUrl.replace(/\/$/, "")}${bookPath}`,
        unseenNote,
      }),
    );
    return { kind: "done" as const, code: issued.code, bookPath, valueCents: decision.creditCents, expiresAt, bookingId: booking.id, unseenNote };
  });

  if (outcome.kind === "not_found") return { ok: false, status: 404, code: "not_found", message: "Booking not found." };
  if (outcome.kind === "blocked") {
    // Nothing paid that the site knows of: a link the processor could not answer about may have been.
    const unseenNote =
      outcome.reason !== "nothing_paid" || !unseen
        ? ""
        : look === "foreign"
          ? " The site cannot check the payment link for this booking. If you paid it, please contact us."
          : " We could not check just now whether the payment link for this booking was paid. If you paid it, please try again later, or call us.";
    const said = outcome.reason === "not_confirmed" ? endedText(outcome.booking) : rescheduleBlockText(outcome.reason, outcome.terms, outcome.heldCents);
    return { ok: false, status: 409, code: outcome.reason, message: `${said}${unseenNote}` };
  }
  if (outcome.kind === "changed") return { ok: false, status: 409, code: "changed", message: LOOK_AGAIN };
  if (!unseen) await closePayLinkOf(db, outcome.bookingId, deps);
  return {
    ok: true,
    code: outcome.code,
    bookPath: outcome.bookPath,
    valueCents: outcome.valueCents,
    expiresAt: outcome.expiresAt,
    unseenLink: outcome.unseenNote !== null,
    unseenNote: outcome.unseenNote,
  };
}

// ── Owner actions ────────────────────────────────────────────────────────────

export type OwnerRefundResult =
  | {
      ok: true;
      refund: RefundsState;
      refundCents: number;
      /** Money taken at the studio for a booking the studio cancelled: the studio gives back by hand what it owes of it. */
      atStudioCents?: number;
      /** The processor could not say whether the booking's payment link was paid, or it was another processor's (`noteUnseenLink`). */
      unseenLink?: "unseen" | "foreign" | "none";
    }
  | { ok: false; status: number; code: "not_found" | "bad_amount" | "not_cancellable" | "changed"; message: string };

/**
 * What the owner can still send back to the card for a booking: what the card
 * holds, less a pet fee that was already returned as studio credit.
 */
async function ownerRefundable(
  db: DbLike,
  bookingId: string,
): Promise<{ available: number; returned: number; petFee: number; code: RescheduleCode | null }> {
  const held = await netCardPaidCents(db, bookingId);
  // The card's part of the pet fee's credit: the credit may be only part of the fee.
  const returned = Math.min(held, await petFeeReturnedCents(db, bookingId));
  const petFee = await petFeeCentsOf(db, bookingId);
  // Released for a reschedule code: its money is on the code, and a refund comes off it.
  const code = await rescheduleCodeOf(db, bookingId);
  const available = code ? Math.min(held - returned, code.valueCents) : held - returned;
  return { available, returned, petFee, code };
}

function tooMuchText(outcome: { available: number; returned: number; petFee: number; code: { code: string; valueCents: number } | null }): string {
  // The part of the pet fee that came out of what the card paid: the credit may have been only part of the fee.
  const why = [
    ...(outcome.returned > 0
      ? [
          outcome.returned < outcome.petFee
            ? `${formatCents(outcome.returned)} of what the card paid was for the pet fee, which was returned as studio credit`
            : `its pet fee (${formatCents(outcome.petFee)}) was already returned as studio credit`,
        ]
      : []),
    ...(outcome.code ? [`what was paid is on its reschedule code ${outcome.code.code}, which has ${formatCents(outcome.code.valueCents)} left`] : []),
  ];
  return `At most ${formatCents(outcome.available)} can be refunded to the card for this booking${why.length > 0 ? `: ${why.join("; ")}` : ""}.`;
}

/**
 * The owner's cancel: any booking that has not been cancelled already, with
 * whatever refund the owner chooses, up to what the card still holds, less a
 * pet fee already returned as credit.
 */
export async function ownerCancelBooking(
  db: Db,
  ref: string,
  /** `seenCardCents`: what the card held as the owner's page showed it; money received since refuses the cancel. */
  input: { refundCents: number; seenCardCents?: number },
  deps: ManageDeps,
): Promise<OwnerRefundResult> {
  if (!isBookingRef(ref)) return { ok: false, status: 404, code: "not_found", message: "Booking not found." };
  if (!Number.isInteger(input.refundCents) || input.refundCents < 0) {
    return { ok: false, status: 400, code: "bad_amount", message: "Enter a refund amount of zero or more." };
  }
  const look = await countPaidLink(db, ref, null, deps);
  const unseen = look === "unanswered" || look === "foreign";

  const outcome = await db.transaction(async (tx) => {
    const [booking] = await tx.select().from(bookings).where(eq(bookings.ref, ref)).for("update").limit(1);
    if (!booking) return { kind: "not_found" as const };
    if (!["confirmed", "completed", "no_show"].includes(booking.status)) return { kind: "not_cancellable" as const };
    // Card money received since the owner's page was drawn (a payment link paid meanwhile): the refund they chose did
    // not count it. They look again.
    const held = await netCardPaidCents(tx, booking.id);
    if (input.seenCardCents !== undefined && held !== input.seenCardCents) return { kind: "changed" as const, held };
    const refundable = await ownerRefundable(tx, booking.id);
    if (input.refundCents > refundable.available) return { kind: "bad_amount" as const, ...refundable };

    await tx
      .update(bookings)
      .set({ status: "cancelled", cancelledAt: deps.now, cancelReason: "owner" })
      .where(eq(bookings.id, booking.id));
    await releaseHolds(tx, booking.id);
    const refundIds = await recordRefunds(tx, booking.id, input.refundCents, `Cancelled by the studio: ${booking.ref}`, false);
    // Money taken at the studio cannot be sent back from here: the studio gives back by hand what it owes of it, the
    // pet fee aside when it was already returned as studio credit.
    const { cents: atStudio, petReturnedCents: petAside } = await studioRefundableCents(tx, booking.id);
    await recordEvent(tx, {
      bookingId: booking.id,
      from: labelOf(booking),
      to: "cancelled",
      actor: BY_STUDIO,
      at: deps.now,
      note: [
        input.refundCents > 0 ? `Refund ${formatCents(input.refundCents)}` : "No refund",
        ...(atStudio > 0
          ? [`${formatCents(atStudio)} of what was paid at the studio is for the studio to give back by hand${petAside > 0 ? " (its pet fee was returned as studio credit)" : ""}`]
          : []),
      ].join("; "),
    });
    // A visit that has not started was taken from the customer, so the code that paid for it goes back to them.
    // After the start the code has done its work: a later cancellation is the owner settling a refund.
    const codeBack = deps.now.getTime() < booking.startAt.getTime() && (await giveCodeBack(tx, booking, "studio"));
    const unseenNote = unseen ? await noteUnseenLink(tx, booking, "cancelled", deps) : null;
    const email: CancellationNotice = {
      to: booking.customerEmail,
      name: booking.customerName,
      ref: booking.ref,
      when: formatInstant(booking.startAt),
      byStudio: true,
      ...(input.refundCents > 0 ? { refund: { cents: input.refundCents, feeCents: 0 } } : {}),
      lines: [
        ...(atStudio > 0
          ? [
              petAside > 0
                ? `Of what you paid at the studio, ${formatCents(atStudio)} can be given back (the rest was for the pet fee, which was returned to you as studio credit): it cannot be sent back online, so the studio will be in touch with you about it.`
                : `What you paid at the studio (${formatCents(atStudio)}) cannot be sent back online: the studio will be in touch with you about it.`,
            ]
          : []),
        ...(codeBack ? [CODE_BACK] : []),
        ...(unseenNote ? [unseenNote] : []),
        "Please contact us with any questions.",
      ],
    };
    const emailId = await queueEmail(tx, noticeEmail(email, "sent"));
    return { kind: "done" as const, refundIds, bookingId: booking.id, email, emailId, atStudio, unseenNote };
  });

  if (outcome.kind === "not_found") return { ok: false, status: 404, code: "not_found", message: "Booking not found." };
  if (outcome.kind === "not_cancellable") {
    return { ok: false, status: 409, code: "not_cancellable", message: "This booking is already cancelled or was never confirmed." };
  }
  if (outcome.kind === "bad_amount") return { ok: false, status: 400, code: "bad_amount", message: tooMuchText(outcome) };
  if (outcome.kind === "changed") {
    return {
      ok: false,
      status: 409,
      code: "changed",
      message: `The money on this booking changed after this page was opened: the card now holds ${formatCents(outcome.held)}. Look at it again, then cancel.`,
    };
  }
  const refund = await sendRefunds(db, outcome.refundIds, deps);
  if (refund === "pending" || refund === "waiting") await refundNotSent(db, outcome.emailId, outcome.email);
  // After the money, and not while the processor cannot answer about the link (see `cancelBooking`).
  if (!unseen) await closePayLinkOf(db, outcome.bookingId, deps);
  return {
    ok: true,
    refund,
    refundCents: input.refundCents,
    ...(outcome.atStudio > 0 ? { atStudioCents: outcome.atStudio } : {}),
    ...(outcome.unseenNote ? { unseenLink: look === "foreign" ? (deps.payments ? ("foreign" as const) : ("none" as const)) : ("unseen" as const) } : {}),
  };
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
    const refundable = await ownerRefundable(tx, booking.id);
    if (input.amountCents > refundable.available) return { kind: "bad_amount" as const, ...refundable };
    const reason = input.reason.slice(0, 180);
    // What a released booking refunds comes off the code its money went into: the money comes back once. The client is
    // told, and told again should the refund not go through.
    if (refundable.code && !(await takeOffRescheduleCode(tx, refundable.code.id, input.amountCents))) return { kind: "bad_amount" as const, ...refundable };
    const told = refundable.code
      ? {
          to: booking.customerEmail,
          name: booking.customerName,
          ref: booking.ref,
          code: refundable.code.code,
          cents: input.amountCents,
          leftCents: refundable.code.valueCents - input.amountCents,
          usable: spendable(refundable.code, deps.now),
          byHand: false,
        }
      : null;
    const toldId = told ? await queueEmail(tx, codeRefundEmail({ ...told, state: "sent" })) : null;
    const refundIds = await recordRefunds(tx, booking.id, input.amountCents, reason || `Refund for ${booking.ref}`, false);
    const label = labelOf(booking);
    await recordEvent(tx, {
      bookingId: booking.id,
      from: label,
      to: label,
      actor: BY_STUDIO,
      at: deps.now,
      note: `Refund ${formatCents(input.amountCents)} to the card${reason ? `: ${reason}` : ""}${
        refundable.code
          ? `; taken off the reschedule code ${refundable.code.code}, which has ${formatCents(refundable.code.valueCents - input.amountCents)} left`
          : ""
      }`,
    });
    return { kind: "done" as const, refundIds, told, toldId };
  });
  if (outcome.kind === "not_found") return { ok: false, status: 404, code: "not_found", message: "Booking not found." };
  if (outcome.kind === "bad_amount") return { ok: false, status: 400, code: "bad_amount", message: tooMuchText(outcome) };
  const refund = await sendRefunds(db, outcome.refundIds, deps);
  if ((refund === "pending" || refund === "waiting") && outcome.told && outcome.toldId) {
    const notYet = codeRefundEmail({ ...outcome.told, state: "not_yet" });
    if (!(await replaceQueuedEmail(db, outcome.toldId, notYet))) await queueEmail(db, notYet);
  }
  return { ok: true, refund, refundCents: input.amountCents };
}
