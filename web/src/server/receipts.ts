import { durationLabel } from "@/lib/domain/time";
import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm";
import { bookings, paymentLinks, payments, refunds } from "@/db/schema";
import type { DbLike } from "@/db/client";
import { isPaymentMethod, MANUAL_PROVIDER, PAYMENT_METHODS } from "@/lib/payment-methods";
import { customerStatus } from "./account";
import { toBookingViews, type BookingView } from "./bookings";
import { creditName } from "./promos";
import { localDateOf } from "./tz";

/**
 * Receipts and payment history, for a customer's account and for the owners.
 *
 * A receipt is made from payment records and from nothing else: every amount
 * on it is what was actually paid when it was paid, and the lines above the
 * payments are the prices the booking was sold at, which are kept with the
 * booking and never read from today's price list. A booking for which no
 * payment was recorded has no receipt: one that still owes money is listed
 * as "to pay", and one that a code paid for in full cost nothing.
 *
 * No tax is shown: the site's prices are final amounts, and whether they
 * include tax, and at what rate, is the accountant's to say (see ProjectLibrary.md).
 */

export interface ReceiptLine {
  label: string;
  /** Negative for a discount or a credit. */
  cents: number;
}

export interface ReceiptRefund {
  /** When it was sent, or made by hand; for one not made yet, when it was recorded. */
  at: string;
  amountCents: number;
  /**
   * `made`: the money went back. `on_its_way`: the card processor accepted
   * it and has not completed it yet. `owed`: recorded and not made, because
   * it failed or has not been sent yet; it does not count as refunded until
   * it is made (the scheduled task tries it again, or the owner makes it in
   * Square and records that).
   */
  state: "made" | "on_its_way" | "owed";
  reason: string;
}

export interface ReceiptPayment {
  id: string;
  at: string;
  /** How it was paid, in words. */
  how: string;
  amountCents: number;
  refunds: ReceiptRefund[];
}

export type ReceiptStatus = "paid" | "partly_paid" | "partly_refunded" | "refunded";

/** What a receipt says after a refund's date: nothing for one that was made. */
export const REFUND_STATE_WORDS: Record<ReceiptRefund["state"], string> = { made: "", on_its_way: " (on its way)", owed: " (owed, not made yet)" };

export const RECEIPT_STATUS_TEXT: Record<ReceiptStatus, string> = {
  paid: "Paid",
  partly_paid: "Partly paid",
  partly_refunded: "Partly refunded",
  refunded: "Refunded",
};

export interface Receipt {
  /** The booking's reference, which is also the receipt's number. */
  ref: string;
  customerName: string;
  customerEmail: string;
  visitStart: string;
  visitEnd: string;
  durationMinutes: number;
  /** The studios, by name. */
  studios: string;
  photography: boolean;
  /** The booking's status in the customer's words: "Completed", "Cancelled". */
  bookingStatus: string;
  /** What was sold, at the prices it was sold at: studios, add-ons, then discounts and credit as negative lines. */
  lines: ReceiptLine[];
  /** What the booking came to after discounts and credit. */
  totalCents: number;
  /** The payments that succeeded, oldest first. */
  payments: ReceiptPayment[];
  paidCents: number;
  /** Given back, or accepted by the card processor and on its way back. A refund owed and not made is not counted. */
  refundedCents: number;
  /** Paid, less what was given back. */
  netCents: number;
  /** Still to pay. */
  dueCents: number;
  status: ReceiptStatus;
  /** When the first payment was made: the receipt's date. */
  paidAt: string;
}

/** A booking that owes money and has no payment yet. An invoice, not a receipt. */
export interface Unpaid {
  ref: string;
  visitStart: string;
  studios: string;
  dueCents: number;
}

function linesOf(booking: BookingView): ReceiptLine[] {
  const lines: ReceiptLine[] = booking.studios.map((studio) => ({
    label: booking.photography ? `Photography session, ${studio.name} (studio included)` : studio.name,
    cents: studio.priceCents,
  }));
  if (booking.multiStudioDiscountCents > 0) lines.push({ label: "Discount for booking several studios", cents: -booking.multiStudioDiscountCents });
  for (const addon of booking.addons) {
    lines.push({ label: addon.quantity > 1 ? `${addon.name} × ${addon.quantity}` : addon.name, cents: addon.unitCents * addon.quantity });
  }
  if (booking.promoDiscountCents > 0) {
    const label =
      booking.creditAppliedCents > 0
        ? `Paid with ${creditName(booking.promoSource ?? "reschedule")}`
        : booking.promoKind === "free_hour"
          ? "Free hour"
          : "Discount code";
    lines.push({ label, cents: -booking.promoDiscountCents });
  }
  if (booking.membershipCents > 0) lines.push({ label: `Paid with membership hours (${durationLabel(booking.membershipMinutes)})`, cents: -booking.membershipCents });
  for (const charge of booking.charges) lines.push({ label: charge.label, cents: charge.cents });
  return lines;
}

/**
 * Every receipt of an email address, newest first by the day it was paid,
 * and the bookings that still owe everything. Abandoned checkouts are not
 * bookings and are left out.
 */
export async function loadReceipts(db: DbLike, email: string): Promise<{ receipts: Receipt[]; unpaid: Unpaid[] }> {
  const rows = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.customerEmail, email.trim().toLowerCase()), notInArray(bookings.status, ["pending_payment", "expired"])))
    .orderBy(desc(bookings.startAt))
    .limit(1000);
  if (rows.length === 0) return { receipts: [], unpaid: [] };
  const views = await toBookingViews(db, rows);
  const ids = rows.map((row) => row.id);

  const paid = await db
    .select()
    .from(payments)
    .where(and(inArray(payments.bookingId, ids), eq(payments.status, "succeeded")))
    .orderBy(asc(payments.createdAt));
  const back =
    paid.length > 0
      ? await db
          .select()
          .from(refunds)
          .where(
            inArray(
              refunds.paymentId,
              paid.map((payment) => payment.id),
            ),
          )
          .orderBy(asc(refunds.createdAt))
      : [];
  const throughLink = new Set(
    (await db.select({ paymentId: paymentLinks.paymentId }).from(paymentLinks).where(inArray(paymentLinks.bookingId, ids))).map((row) => row.paymentId),
  );

  const receipts: Receipt[] = [];
  const unpaid: Unpaid[] = [];
  for (const [index, booking] of views.entries()) {
    const studios = booking.studios.map((studio) => studio.name).join(" + ");
    const own = paid.filter((payment) => payment.bookingId === rows[index].id);
    if (own.length === 0) {
      // Nothing was paid: no receipt. What it owes, when the booking still stands, is an invoice.
      if (booking.dueCents > 0 && ["confirmed", "completed", "no_show"].includes(booking.status)) {
        unpaid.push({ ref: booking.ref, visitStart: booking.startAt, studios, dueCents: booking.dueCents });
      }
      continue;
    }
    const list: ReceiptPayment[] = own.map((payment) => ({
      id: payment.id,
      at: payment.createdAt.toISOString(),
      how:
        payment.provider === MANUAL_PROVIDER
          ? `At the studio: ${isPaymentMethod(payment.method) ? PAYMENT_METHODS[payment.method].toLowerCase() : "payment"}`
          : throughLink.has(payment.id)
            ? "Card, through a payment link"
            : "Card, online",
      amountCents: payment.amountCents,
      refunds: back
        .filter((refund) => refund.paymentId === payment.id)
        .map((refund): ReceiptRefund => {
          // Money given back at the studio was made when it was recorded; a card refund once the processor completed it.
          const state = refund.status !== "succeeded" ? "owed" : payment.provider === MANUAL_PROVIDER || refund.settledAt !== null ? "made" : "on_its_way";
          return {
            // When it was sent (or made by hand, see recordRefundMadeInSquare), not when the processor finished it.
            at: refund.createdAt.toISOString(),
            amountCents: refund.amountCents,
            state,
            reason: refund.reason,
          };
        }),
    }));
    const paidCents = list.reduce((sum, payment) => sum + payment.amountCents, 0);
    const refundedCents = list.reduce(
      (sum, payment) => sum + payment.refunds.reduce((part, refund) => part + (refund.state === "owed" ? 0 : refund.amountCents), 0),
      0,
    );
    receipts.push({
      ref: booking.ref,
      customerName: booking.customerName,
      customerEmail: booking.customerEmail,
      visitStart: booking.startAt,
      visitEnd: booking.endAt,
      durationMinutes: booking.durationMinutes,
      studios,
      photography: booking.photography !== null,
      bookingStatus: customerStatus(booking).text,
      lines: linesOf(booking),
      totalCents: booking.totalCents + booking.chargesCents,
      payments: list,
      paidCents,
      refundedCents,
      netCents: paidCents - refundedCents,
      dueCents: booking.dueCents,
      // Partly paid: less than the total, whether the rest is still owed or the booking ended before it was.
      status: refundedCents >= paidCents ? "refunded" : refundedCents > 0 ? "partly_refunded" : paidCents < booking.totalCents + booking.chargesCents ? "partly_paid" : "paid",
      paidAt: list[0].at,
    });
  }
  receipts.sort((a, b) => (a.paidAt < b.paidAt ? 1 : -1));
  return { receipts, unpaid };
}

/** One receipt of an email address, by the booking's reference. Null when it is not theirs, or nothing was paid. */
export async function getReceipt(db: DbLike, email: string, ref: string): Promise<Receipt | null> {
  if (!/^VS-[0-9A-Z]{6}$/.test(ref)) return null;
  return (await loadReceipts(db, email)).receipts.find((receipt) => receipt.ref === ref) ?? null;
}

/** A payment or a refund on its own, for a list by date. */
export interface Transaction {
  at: string;
  kind: "payment" | "refund";
  ref: string;
  visitStart: string;
  studios: string;
  /** How it was paid; for a refund, why. */
  detail: string;
  /** Positive for a payment, negative for a refund. */
  cents: number;
  pending: boolean;
}

export function transactionsOf(receipts: Receipt[]): Transaction[] {
  const all: Transaction[] = [];
  for (const receipt of receipts) {
    for (const payment of receipt.payments) {
      const shared = { ref: receipt.ref, visitStart: receipt.visitStart, studios: receipt.studios };
      all.push({ ...shared, at: payment.at, kind: "payment", detail: payment.how, cents: payment.amountCents, pending: false });
      // Money that moved: a refund owed and not made yet is on its receipt, not among the payments and refunds.
      for (const refund of payment.refunds) {
        if (refund.state === "owed") continue;
        all.push({ ...shared, at: refund.at, kind: "refund", detail: refund.reason, cents: -refund.amountCents, pending: refund.state === "on_its_way" });
      }
    }
  }
  return all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** The calendar year, on the studio's clock, in which something was paid or given back. */
export function yearOf(instant: string): number {
  return Number(localDateOf(new Date(instant)).slice(0, 4));
}

/** The years in which anything was paid or refunded, newest first. */
export function yearsOf(receipts: Receipt[]): number[] {
  return [...new Set(transactionsOf(receipts).map((transaction) => yearOf(transaction.at)))].sort((a, b) => b - a);
}

export interface YearStatement {
  year: number;
  /** Every payment and refund dated in the year, newest first. */
  transactions: Transaction[];
  /** The receipts that have a payment or a refund in the year, newest first. */
  receipts: Receipt[];
  paidCents: number;
  refundedCents: number;
  /** Paid in the year, less refunded in the year. */
  netCents: number;
}

/**
 * What was paid and given back in one calendar year: the summary for tax and
 * bookkeeping. A payment counts in the year it was made and a refund in the
 * year it was made, whenever the visit itself was.
 */
export function yearStatement(receipts: Receipt[], year: number): YearStatement {
  const transactions = transactionsOf(receipts).filter((transaction) => yearOf(transaction.at) === year);
  const refs = new Set(transactions.map((transaction) => transaction.ref));
  const paidCents = transactions.filter((t) => t.kind === "payment").reduce((sum, t) => sum + t.cents, 0);
  const refundedCents = transactions.filter((t) => t.kind === "refund").reduce((sum, t) => sum - t.cents, 0);
  return {
    year,
    transactions,
    receipts: receipts.filter((receipt) => refs.has(receipt.ref)),
    paidCents,
    refundedCents,
    netCents: paidCents - refundedCents,
  };
}
