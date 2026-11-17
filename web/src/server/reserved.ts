import { and, eq, isNull } from "drizzle-orm";
import { bookings, payments, refunds } from "@/db/schema";
import type { Db } from "@/db/client";
import { labelOf } from "@/lib/domain/labels";
import { formatCents } from "@/lib/domain/pricing";
import { ownerCaptureNotice, ownerReservationLapsedNotice, queueEmail, reservationLapsedEmail } from "./email";
import { BY_SYSTEM, recordEvent } from "./history";
import { owedCents } from "./money";
import { RESERVE_HOURS, type PaymentProvider } from "./payments";
import { formatInstant } from "./tz";

/**
 * A booking's card is paid in two steps, so that a card is never charged for a
 * booking that was not made (the owner's go-ahead of 2026-11-16):
 *
 *  1. the amount is reserved on the card (`charge` with `reserve`), and the
 *     payment is recorded as `authorized` in the same transaction that
 *     confirms the booking (src/server/bookings.ts);
 *  2. the amount is then taken (`takeReserved`), and the payment becomes
 *     `succeeded`: from then on it is money, which receipts, refunds and the
 *     admin count.
 *
 * Whatever stops between the two, the processor gives a reserved amount back
 * by itself after `RESERVE_HOURS`. A booking that was not confirmed therefore
 * costs the client nothing. One that was is settled by the scheduled task
 * (`settleReservedPayments`): the money is taken while the booking stands,
 * and given back when it was cancelled first.
 */

export interface SettleDeps {
  now: Date;
  payments: PaymentProvider | null;
  ownerEmail: string | null;
}

/** The payment and booking a reserved amount belongs to, as the owner's notice names them. */
interface Reserved {
  id: string;
  providerPaymentId: string;
  amountCents: number;
  /** What went wrong the last time: the owner is told only the first time. */
  error: string | null;
  ref: string;
  customer: string;
  createdAt: Date;
}

/** The booking statuses for which a reserved amount is taken: the booking stands, visited or not. */
const STANDING = ["confirmed", "completed", "no_show"] as const;

/**
 * Take a reserved amount. The payment becomes `succeeded`. When it does not go
 * through, it stays `authorized` for the scheduled task to try again, and the
 * owner is told the first time, with the hour after which the processor gives
 * the amount back. Answers whether the money was taken.
 */
export async function takeReserved(db: Db, payment: Reserved, deps: SettleDeps): Promise<boolean> {
  if (!deps.payments) return false;
  const result = await deps.payments.capture(payment.providerPaymentId);
  if (result.ok) {
    await recordTaken(db, payment);
    return true;
  }
  await db.transaction(async (tx) => {
    const firstTime = await tx
      .update(payments)
      .set({ error: result.message })
      .where(and(eq(payments.id, payment.id), eq(payments.status, "authorized"), isNull(payments.error)))
      .returning({ id: payments.id });
    if (firstTime.length > 0 && deps.ownerEmail) {
      await queueEmail(
        tx,
        ownerCaptureNotice({
          to: deps.ownerEmail,
          ref: payment.ref,
          customer: payment.customer,
          amountCents: payment.amountCents,
          reason: result.message,
          givenBackAt: new Date(payment.createdAt.getTime() + RESERVE_HOURS * 3_600_000),
        }),
      );
    }
  });
  return false;
}

/**
 * Record a reserved amount as taken, with its booking locked. A cancellation
 * sends no refund while the money is only reserved, so a booking cancelled
 * while the processor was taking it would keep money it no longer stands for:
 * it gets all of it back, as a refund recorded here and sent by the scheduled
 * task with the others (`retryOpenRefunds`, which runs after this one).
 */
async function recordTaken(db: Db, payment: Reserved): Promise<void> {
  await db.transaction(async (tx) => {
    const [of] = await tx.select({ bookingId: payments.bookingId }).from(payments).where(eq(payments.id, payment.id)).limit(1);
    if (!of) return;
    // Locked as a cancellation locks it: the two cannot pass each other.
    const [booking] = await tx.select({ status: bookings.status }).from(bookings).where(eq(bookings.id, of.bookingId)).for("update").limit(1);
    const taken = await tx
      .update(payments)
      .set({ status: "succeeded", error: null })
      .where(and(eq(payments.id, payment.id), eq(payments.status, "authorized")))
      .returning({ id: payments.id });
    if (taken.length === 0 || !booking || (STANDING as readonly string[]).includes(booking.status)) return;
    await tx.insert(refunds).values({
      paymentId: payment.id,
      amountCents: payment.amountCents,
      reason: `${payment.ref} was cancelled while its reserved amount was being taken: given back in full`,
      automatic: true,
      status: "pending",
    });
  });
}

/**
 * Give back an amount reserved for a booking that does not stand. When the
 * processor does not answer, the payment stays `authorized` and the
 * scheduled task tries again (`settleReservedPayments`); the processor gives
 * it back by itself in the end.
 */
export async function giveBackReserved(
  db: Db,
  payment: { id: string; providerPaymentId: string },
  provider: PaymentProvider,
  why = "the booking was not made",
): Promise<boolean> {
  const result = await provider.release(payment.providerPaymentId);
  if (!result.ok) return false;
  const done = await db
    .update(payments)
    .set({ status: "failed", error: `Given back before it was taken: ${why}.` })
    .where(and(eq(payments.id, payment.id), eq(payments.status, "authorized")))
    .returning({ id: payments.id });
  return done.length > 0;
}

/**
 * Settle every reserved amount the moment of booking left behind: take it
 * while its booking stands, give it back when the booking was cancelled
 * first, or never made. Run from the scheduled task.
 */
export async function settleReservedPayments(db: Db, deps: SettleDeps): Promise<{ taken: number; released: number }> {
  if (!deps.payments) return { taken: 0, released: 0 };
  const open = await db
    .select({
      id: payments.id,
      providerPaymentId: payments.providerPaymentId,
      amountCents: payments.amountCents,
      error: payments.error,
      createdAt: payments.createdAt,
      ref: bookings.ref,
      customer: bookings.customerName,
      customerEmail: bookings.customerEmail,
      bookingId: bookings.id,
      bookingStatus: bookings.status,
      bookingLabel: bookings.label,
      totalCents: bookings.totalCents,
      startAt: bookings.startAt,
    })
    .from(payments)
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    // Only what the processor set up now reserved: another's is never asked, and never marked, so that a setting
    // wrong for a moment changes nothing for good.
    .where(and(eq(payments.status, "authorized"), eq(payments.provider, deps.payments.name)))
    .limit(50);
  let taken = 0;
  let released = 0;
  for (const row of open) {
    if (!row.providerPaymentId) continue;
    // Lapsed: the processor gave the amount back to the card by itself, and nothing can be taken now. The card was not
    // charged; a booking that stands owes its price (`owedCents` in money.ts), and the owner is told to collect it.
    if (deps.now.getTime() - row.createdAt.getTime() >= RESERVE_HOURS * 3_600_000) {
      await lapse(db, row, deps);
      continue;
    }
    const reserved = { ...row, providerPaymentId: row.providerPaymentId };
    if ((STANDING as readonly string[]).includes(row.bookingStatus)) {
      if (await takeReserved(db, reserved, deps)) taken++;
      continue;
    }
    // Not given back now: tried again next time; the processor gives it back by itself in the end.
    const why = row.bookingStatus === "cancelled" ? "the booking was cancelled first" : "the booking was not made";
    if (await giveBackReserved(db, reserved, deps.payments, why)) released++;
  }
  return { taken, released };
}

/**
 * A reserved amount the processor gave back by itself (`settleReservedPayments`): failed, and written into the
 * booking's history. While the booking stands and still owes something, the owner and the client are told: from the
 * moment the reservation lapsed the booking owed its price (`owedCents`), and the studio may have collected it before
 * the scheduled task came by.
 */
async function lapse(
  db: Db,
  row: {
    id: string;
    amountCents: number;
    ref: string;
    customer: string;
    customerEmail: string;
    bookingId: string;
    bookingStatus: string;
    bookingLabel: string | null;
    totalCents: number;
    startAt: Date;
  },
  deps: SettleDeps,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Locked, as a payment recorded at the studio locks it: what is owed is read as it stands.
    await tx.select({ id: bookings.id }).from(bookings).where(eq(bookings.id, row.bookingId)).for("update");
    const lapsed = await tx
      .update(payments)
      .set({ status: "failed", error: "The amount reserved lapsed before it was taken: the card was not charged." })
      .where(and(eq(payments.id, row.id), eq(payments.status, "authorized")))
      .returning({ id: payments.id });
    if (lapsed.length === 0) return;
    const label = labelOf({ status: row.bookingStatus, label: row.bookingLabel });
    await recordEvent(tx, {
      bookingId: row.bookingId,
      from: label,
      to: label,
      actor: BY_SYSTEM,
      at: deps.now,
      note: `The ${formatCents(row.amountCents)} reserved on the card lapsed before it was taken: the card was not charged`,
    });
    const dueCents = await owedCents(tx, { id: row.bookingId, totalCents: row.totalCents, status: row.bookingStatus }, deps.now);
    if (dueCents <= 0) return;
    if (deps.ownerEmail) {
      await queueEmail(
        tx,
        ownerReservationLapsedNotice({ to: deps.ownerEmail, ref: row.ref, customer: row.customer, amountCents: row.amountCents, dueCents }),
      );
    }
    await queueEmail(
      tx,
      reservationLapsedEmail({ to: row.customerEmail, name: row.customer, ref: row.ref, when: formatInstant(row.startAt), dueCents }),
    );
  });
}
