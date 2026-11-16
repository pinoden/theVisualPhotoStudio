import { and, eq, inArray, isNull } from "drizzle-orm";
import { bookings, payments } from "@/db/schema";
import type { Db } from "@/db/client";
import { ownerCaptureNotice, queueEmail } from "./email";
import { RESERVE_HOURS, type PaymentProvider } from "./payments";

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
    await db.update(payments).set({ status: "succeeded", error: null }).where(and(eq(payments.id, payment.id), eq(payments.status, "authorized")));
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

/** The booking statuses for which a reserved amount is taken: the booking stands, visited or not. */
const STANDING = ["confirmed", "completed", "no_show"] as const;

/**
 * Settle every reserved amount the moment of booking left behind: take it
 * while its booking stands, give it back when the booking was cancelled
 * first. Run from the scheduled task.
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
      bookingStatus: bookings.status,
    })
    .from(payments)
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .where(eq(payments.status, "authorized"))
    .limit(50);
  let taken = 0;
  let released = 0;
  for (const row of open) {
    if (!row.providerPaymentId) continue;
    const reserved = { ...row, providerPaymentId: row.providerPaymentId };
    if ((STANDING as readonly string[]).includes(row.bookingStatus)) {
      if (await takeReserved(db, reserved, deps)) taken++;
      continue;
    }
    const result = await deps.payments.release(row.providerPaymentId);
    if (!result.ok) continue; // tried again next time; the processor gives it back by itself in the end
    const done = await db
      .update(payments)
      .set({ status: "failed", error: "Given back before it was taken: the booking was cancelled first." })
      .where(and(eq(payments.id, row.id), inArray(payments.status, ["authorized"])))
      .returning({ id: payments.id });
    if (done.length > 0) released++;
  }
  return { taken, released };
}
