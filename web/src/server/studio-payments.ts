import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { bookings, paymentLinks, payments, promoCodes, refunds } from "@/db/schema";
import type { Db, DbLike } from "@/db/client";
import { labelOf } from "@/lib/domain/labels";
import { formatCents } from "@/lib/domain/pricing";
import { isPaymentMethod, MANUAL_PROVIDER, PAYMENT_METHODS, type PaymentMethod } from "@/lib/payment-methods";
import { can } from "@/lib/abilities";
import type { AuthUser } from "./auth";
import { isBookingRef } from "./bookings";
import { codeRefundEmail, paymentReceivedEmail, queueEmail } from "./email";
import { recordEvent } from "./history";
import { openPayLinkOf } from "./pay-links";
import { netCardPaidCents, paidAtStudioCents, STANDS } from "./money";
import { petFeeCentsOf, studioRefundableCents } from "./pet-fee";
import { codeStanding, rescheduleCodeOf, spendable, takeOffRescheduleCode } from "./promos";
import { loadSettings } from "./settings";
import { canViewDay } from "./staff";
import { isRetiredTestPayment } from "./test-mode";
import { formatInstant, localDateOf } from "./tz";

/**
 * Money taken at the studio, recorded by hand: "mark as paid".
 *
 * A booking an administrator makes for a client charges nothing online: the
 * client pays at the studio. What they pay is recorded here, so the booking
 * shows what is still owed and what was received, by whom it was recorded and
 * how it was paid. The site never moved this money, so it cannot send it
 * back: a refund of it is given by hand and recorded here as well.
 *
 * Every function checks the viewer itself. Owners can do all of it. Staff can
 * record a payment when the owners have switched that on
 * (`staffRecordsPayments`), on the days they may see; taking a record back
 * and recording a refund are the owners' alone.
 */

type BookingRow = typeof bookings.$inferSelect;

export interface PaymentLine {
  id: string;
  at: string;
  /** True for money taken at the studio and recorded by hand; false for a card charged through the site. */
  byHand: boolean;
  /** How it was paid, in words: "Cash", or "Card, online". */
  how: string;
  amountCents: number;
  refundedCents: number;
  /** A record taken back by an owner. It no longer counts. */
  voided: boolean;
  recordedBy: string | null;
  note: string;
}

export interface BookingMoney {
  totalCents: number;
  /** Every payment that succeeded, before refunds. */
  receivedCents: number;
  /** What is still to pay: nothing once the booking has ended. */
  dueCents: number;
  /** How the booking ended, if it has: then nothing more is to pay, whatever was received. */
  ended: "cancelled" | "released" | null;
  /** Its card payment was taken in test mode, and no longer counts (src/server/test-mode.ts). */
  testMode: boolean;
  payments: PaymentLine[];
}

/** What a booking has received and still owes, with each payment. Failed and abandoned card attempts are left out. */
export async function moneyOf(
  db: DbLike,
  booking: Pick<BookingRow, "id" | "totalCents" | "madeBy" | "status" | "cancelReason">,
): Promise<BookingMoney> {
  const rows = await db
    .select()
    .from(payments)
    .where(and(eq(payments.bookingId, booking.id), inArray(payments.status, ["succeeded", "voided"])))
    .orderBy(asc(payments.createdAt));
  const receivedCents = rows.filter((row) => row.status === "succeeded").reduce((sum, row) => sum + row.amountCents, 0);
  // Paid in test mode, and retired once the live processor was set up: nothing was received for it.
  const testMode = rows.some(isRetiredTestPayment);
  // The card payments that came in through a payment link, to say so beside them.
  const throughLink = new Set(
    (
      await db
        .select({ paymentId: paymentLinks.paymentId })
        .from(paymentLinks)
        .where(and(eq(paymentLinks.bookingId, booking.id), isNotNull(paymentLinks.paymentId)))
    ).map((row) => row.paymentId),
  );
  return {
    totalCents: booking.totalCents,
    receivedCents,
    // A booking made online is paid in full when it is made, so only one made in the admin can owe anything, or one
    // whose payment was taken in test mode (`testMode`); and only while it stands: a cancelled one, or one released for
    // a reschedule code, owes nothing.
    dueCents:
      (booking.madeBy !== null || testMode) && STANDS.includes(booking.status) ? Math.max(0, booking.totalCents - receivedCents) : 0,
    testMode,
    ended: STANDS.includes(booking.status) ? null : booking.cancelReason === "rescheduled" ? "released" : "cancelled",
    payments: rows.map((row) => ({
      id: row.id,
      at: row.createdAt.toISOString(),
      byHand: row.provider === MANUAL_PROVIDER,
      how: isRetiredTestPayment(row)
        ? "Card, in test mode: no money moved"
        : row.provider === MANUAL_PROVIDER
          ? isPaymentMethod(row.method)
            ? PAYMENT_METHODS[row.method]
            : "At the studio"
          : throughLink.has(row.id)
            ? "Card, through the payment link"
            : "Card, online",
      amountCents: row.amountCents,
      refundedCents: row.refundedCents,
      voided: row.status === "voided",
      recordedBy: row.recordedBy,
      note: row.note,
    })),
  };
}

export type StudioPaymentBlock =
  | "forbidden"
  | "not_found"
  | "not_active"
  | "bad_amount"
  | "bad_method"
  | "nothing_due"
  | "too_much"
  /** A payment link is open for the booking: the client could pay it as well. */
  | "link_open";

export type StudioPaymentResult =
  | { ok: true; amountCents: number; dueCents: number }
  | { ok: false; reason: StudioPaymentBlock; message: string };

const refuse = (reason: StudioPaymentBlock, message: string) => ({ ok: false as const, reason, message });

/**
 * Record a payment taken at the studio for a booking: "mark as paid". The
 * amount can be all that is still owed or a part of it, never more. The
 * client is emailed a confirmation, and the booking's history gets a line.
 */
export async function recordStudioPayment(
  db: Db,
  viewer: AuthUser,
  ref: string,
  input: { amountCents: number; method: string; note: string },
  now: Date,
): Promise<StudioPaymentResult> {
  const settings = await loadSettings(db);
  if (!can(viewer, "recordPayments", settings)) return refuse("forbidden", "You cannot record payments.");
  if (!isBookingRef(ref)) return refuse("not_found", "Booking not found.");
  if (!isPaymentMethod(input.method)) return refuse("bad_method", "Choose how it was paid.");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return refuse("bad_amount", "Enter the amount that was paid, above zero.");
  }
  const method: PaymentMethod = input.method;

  return db.transaction(async (tx): Promise<StudioPaymentResult> => {
    // Locked, so two people recording the same cash at once cannot both be told it was still owed.
    const [booking] = await tx.select().from(bookings).where(eq(bookings.ref, ref)).for("update").limit(1);
    // Staff are told "forbidden" for an unknown reference too, so they cannot probe for bookings.
    if (!booking) return viewer.role === "owner" ? refuse("not_found", "Booking not found.") : refuse("forbidden", "You cannot record a payment for that booking.");
    if (!(await canViewDay(tx, viewer, localDateOf(booking.startAt)))) return refuse("forbidden", "You cannot record a payment for that booking.");
    if (!["confirmed", "completed", "no_show"].includes(booking.status)) {
      return refuse("not_active", "A payment can be recorded for a booking that is confirmed or has taken place, not for a cancelled one.");
    }
    const money = await moneyOf(tx, booking);
    if (money.dueCents <= 0) return refuse("nothing_due", "Nothing is owed for this booking.");
    const link = await openPayLinkOf(tx, booking.id);
    if (link) {
      return refuse(
        "link_open",
        `A payment link for ${formatCents(link.amountCents)} is open for this booking. Cancel the link before recording a payment by hand, so that the client cannot pay twice.`,
      );
    }
    if (input.amountCents > money.dueCents) {
      return refuse("too_much", `Only ${formatCents(money.dueCents)} is still to pay for this booking.`);
    }

    await tx.insert(payments).values({
      bookingId: booking.id,
      provider: MANUAL_PROVIDER,
      amountCents: input.amountCents,
      status: "succeeded",
      method,
      recordedBy: viewer.email,
      note: input.note.slice(0, 200),
      createdAt: now,
    });
    const dueCents = money.dueCents - input.amountCents;
    const label = labelOf(booking);
    await recordEvent(tx, {
      bookingId: booking.id,
      from: label,
      to: label,
      actor: viewer.email,
      at: now,
      note: `Payment of ${formatCents(input.amountCents)} recorded (${PAYMENT_METHODS[method].toLowerCase()})${
        dueCents > 0 ? `; ${formatCents(dueCents)} still to pay` : "; paid in full"
      }`,
    });
    await queueEmail(
      tx,
      paymentReceivedEmail({
        to: booking.customerEmail,
        name: booking.customerName,
        ref: booking.ref,
        when: formatInstant(booking.startAt),
        amountCents: input.amountCents,
        method: PAYMENT_METHODS[method],
        dueCents,
      }),
    );
    return { ok: true, amountCents: input.amountCents, dueCents };
  });
}

export type RecordChangeResult = { ok: true } | { ok: false; message: string };

/** The payment recorded by hand that an owner wants to change, locked together with its booking. */
async function manualPaymentForUpdate(tx: DbLike, paymentId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(paymentId)) return null;
  const [row] = await tx
    .select({ payment: payments, booking: bookings })
    .from(payments)
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .where(and(eq(payments.id, paymentId), eq(payments.provider, MANUAL_PROVIDER)))
    .for("update")
    .limit(1);
  return row ?? null;
}

/**
 * Take back a payment that was recorded by mistake. The record stays, marked
 * as taken back, and no longer counts: the booking owes that amount again.
 * Not for money that was really paid and then given back: record that as a
 * refund instead.
 */
/** `owesAgain`: the booking still stands, so it owes the amount again; one that has ended owes nothing (`STANDS`). */
export type VoidResult = { ok: true; owesAgain: boolean } | { ok: false; message: string };

export async function voidStudioPayment(db: Db, viewer: AuthUser, paymentId: string, reason: string, now: Date): Promise<VoidResult> {
  if (viewer.role !== "owner") return { ok: false, message: "Only an owner can take a payment record back." };
  return db.transaction(async (tx): Promise<VoidResult> => {
    const found = await manualPaymentForUpdate(tx, paymentId);
    if (!found) return { ok: false, message: "That payment record was not found." };
    const { payment, booking } = found;
    if (payment.status !== "succeeded") return { ok: false, message: "That payment record was already taken back." };
    if (payment.refundedCents > 0) {
      return { ok: false, message: "A refund is recorded against that payment, so it was really paid and cannot be taken back." };
    }
    // Money that came back as a code of studio credit, the pet fee's or a reschedule code's, is not taken back while the
    // code can be spent, nor once it paid for a booking: the record goes only once the code is cancelled, or ran out unspent.
    const [credit] = await tx
      .select({ id: promoCodes.id })
      .from(promoCodes)
      .where(and(eq(promoCodes.originBookingId, booking.id), eq(promoCodes.source, "pet_fee")))
      .limit(1);
    const held = (await netCardPaidCents(tx, booking.id)) + (await paidAtStudioCents(tx, booking.id)) + booking.creditAppliedCents - payment.amountCents;
    if (credit && held < (await petFeeCentsOf(tx, booking.id))) {
      const standing = await codeStanding(tx, credit.id, now);
      if (standing.usedCents > 0) {
        return {
          ok: false,
          message: `The pet fee of this booking came back as studio credit (code ${standing.code}), and ${formatCents(standing.usedCents)} of it was used: this record cannot be taken back.`,
        };
      }
      if (standing.usable) {
        return {
          ok: false,
          message: `The pet fee of this booking was returned as studio credit (code ${standing.code}) for what was paid. Cancel that code under Codes first, then take this record back.`,
        };
      }
    }
    const moved = await rescheduleCodeOf(tx, booking.id);
    if (moved) {
      const standing = await codeStanding(tx, moved.id, now);
      if (standing.usedCents > 0) {
        return {
          ok: false,
          message: `This booking's money went into its reschedule code ${moved.code}, and ${formatCents(standing.usedCents)} of it was spent or refunded: this record cannot be taken back.`,
        };
      }
      if (standing.usable) {
        return {
          ok: false,
          message: `This booking's money went into its reschedule code ${moved.code} (${formatCents(moved.valueCents)} left). Cancel that code under Codes first, then take this record back.`,
        };
      }
    }
    const why = reason.trim().slice(0, 200);
    await tx
      .update(payments)
      .set({ status: "voided", error: `Taken back by ${viewer.email}${why ? `: ${why}` : ""}` })
      .where(eq(payments.id, payment.id));
    const label = labelOf(booking);
    await recordEvent(tx, {
      bookingId: booking.id,
      from: label,
      to: label,
      actor: viewer.email,
      at: now,
      note: `Payment record of ${formatCents(payment.amountCents)} taken back${why ? `: ${why}` : ""}`,
    });
    return { ok: true, owesAgain: STANDS.includes(booking.status) };
  });
}

/**
 * Record a refund the studio gave by hand, of money it took at the studio.
 * Nothing is sent anywhere: this is the record of what a person did.
 */
export async function recordHandRefund(
  db: Db,
  viewer: AuthUser,
  paymentId: string,
  input: { amountCents: number; note: string },
  now: Date,
): Promise<RecordChangeResult> {
  if (viewer.role !== "owner") return { ok: false, message: "Only an owner can record a refund." };
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { ok: false, message: "Enter the amount that was given back, above zero." };
  }
  return db.transaction(async (tx): Promise<RecordChangeResult> => {
    const found = await manualPaymentForUpdate(tx, paymentId);
    if (!found) return { ok: false, message: "That payment record was not found." };
    const { payment, booking } = found;
    if (payment.status !== "succeeded") return { ok: false, message: "That payment record was taken back, so there is nothing to refund." };
    const left = payment.amountCents - payment.refundedCents;
    if (input.amountCents > left) {
      return { ok: false, message: `At most ${formatCents(left)} of that payment can still be refunded.` };
    }
    // A pet fee already returned as studio credit is not given back in cash as well, nor what is on a reschedule code.
    const back = await studioRefundableCents(tx, booking.id);
    const tooMuch = () => {
      // The part of the pet fee that came out of what was paid at the studio: the credit may have been only part of the fee.
      const why = [
        ...(back.petReturnedCents > 0
          ? [
              back.petReturnedCents < back.petFeeCents
                ? `${formatCents(back.petReturnedCents)} of what was paid at the studio was for the pet fee, which was returned as studio credit`
                : `its pet fee (${formatCents(back.petFeeCents)}) was already returned as studio credit`,
            ]
          : []),
        ...(back.code ? [`what was paid is on its reschedule code ${back.code.code}, which has ${formatCents(back.code.valueCents)} left`] : []),
      ];
      return { ok: false as const, message: `At most ${formatCents(back.cents)} can be refunded by hand for this booking${why.length > 0 ? `: ${why.join("; ")}` : ""}.` };
    };
    if (input.amountCents > back.cents) return tooMuch();
    // What a released booking gives back comes off its code, and the client is told.
    if (back.code && !(await takeOffRescheduleCode(tx, back.code.id, input.amountCents))) return tooMuch();
    if (back.code) {
      await queueEmail(
        tx,
        codeRefundEmail({
          to: booking.customerEmail,
          name: booking.customerName,
          ref: booking.ref,
          code: back.code.code,
          cents: input.amountCents,
          leftCents: back.code.valueCents - input.amountCents,
          usable: spendable(back.code, now),
          byHand: true,
        }),
      );
    }
    const why = input.note.trim().slice(0, 180);
    await tx.insert(refunds).values({
      paymentId: payment.id,
      amountCents: input.amountCents,
      status: "succeeded",
      reason: why || `Refunded by hand for ${booking.ref}`,
      automatic: false,
      createdAt: now,
      // Given back at the studio: made, not on its way.
      settledAt: now,
    });
    await tx
      .update(payments)
      .set({ refundedCents: sql`${payments.refundedCents} + ${input.amountCents}` })
      .where(eq(payments.id, payment.id));
    const label = labelOf(booking);
    await recordEvent(tx, {
      bookingId: booking.id,
      from: label,
      to: label,
      actor: viewer.email,
      at: now,
      note: `Refund of ${formatCents(input.amountCents)} given by hand${why ? `: ${why}` : ""}${
        back.code ? `; taken off the reschedule code ${back.code.code}, which has ${formatCents(back.code.valueCents - input.amountCents)} left` : ""
      }`,
    });
    return { ok: true };
  });
}
