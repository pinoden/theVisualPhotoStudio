import { and, eq, inArray } from "drizzle-orm";
import { bookings, paymentLinks, payments } from "@/db/schema";
import type { Db } from "@/db/client";
import { labelOf } from "@/lib/domain/labels";
import { formatCents } from "@/lib/domain/pricing";
import { BY_SYSTEM, recordEvent } from "./history";

/**
 * Leaving test mode. The pretend processor and Square's sandbox move no
 * money: what they recorded (`payments.provider`, `payment_links.provider`)
 * is test money. While the site runs in test mode it counts as money, so that
 * test mode can be tried end to end. Once the live processor is set up, it
 * never may: a booking paid in test mode would otherwise give real credit (a
 * reschedule code worth what it "paid"), a receipt, or a refund.
 */
export const TEST_PROCESSORS = ["mock", "square-sandbox"] as const;

/** What a test payment says once it is retired, on the appointment's page among its payments. */
export const TEST_MODE_NOTE = "Taken in test mode: no money moved.";

/** The processor that takes real money. Anything else set up is test mode. */
export const LIVE_PROCESSOR = "square";

/**
 * Once the live processor is set up, what test mode left is retired: its card
 * payments, taken or only reserved, are voided, so that nothing counts them
 * as money; its open payment links are closed, for they can never be paid.
 * Each booking concerned gets a line in its history. The bookings themselves
 * stand: a booking that stands with nothing received now owes its price, and
 * the overview lists them for the owners, to cancel or to have paid. Nothing
 * of the live processor's, or taken by hand, is touched. Safe to run again;
 * run when the database is opened (`getDb`).
 */
export async function retireTestMode(db: Db, processor: string | null, now: Date): Promise<{ payments: number; links: number }> {
  if (processor !== LIVE_PROCESSOR) return { payments: 0, links: 0 };
  return db.transaction(async (tx) => {
    const voided = await tx
      .update(payments)
      .set({ status: "voided", error: TEST_MODE_NOTE })
      .where(and(inArray(payments.provider, [...TEST_PROCESSORS]), inArray(payments.status, ["pending", "authorized", "succeeded"])))
      .returning({ bookingId: payments.bookingId, amountCents: payments.amountCents });
    const closed = await tx
      .update(paymentLinks)
      .set({ status: "cancelled", cancelledAt: now })
      .where(and(inArray(paymentLinks.provider, [...TEST_PROCESSORS]), eq(paymentLinks.status, "open")))
      .returning({ bookingId: paymentLinks.bookingId, amountCents: paymentLinks.amountCents });
    const notes = new Map<string, string[]>();
    for (const payment of voided) notes.set(payment.bookingId, [...(notes.get(payment.bookingId) ?? []), `card payment of ${formatCents(payment.amountCents)} taken in test mode voided: no money moved`]);
    for (const link of closed) notes.set(link.bookingId, [...(notes.get(link.bookingId) ?? []), `payment link for ${formatCents(link.amountCents)} made in test mode closed`]);
    if (notes.size > 0) {
      const rows = await tx.select().from(bookings).where(inArray(bookings.id, [...notes.keys()]));
      for (const booking of rows) {
        const label = labelOf(booking);
        const said = notes.get(booking.id)!.join("; ");
        await recordEvent(tx, { bookingId: booking.id, from: label, to: label, actor: BY_SYSTEM, at: now, note: `The live card processor was set up: ${said}` });
      }
    }
    return { payments: voided.length, links: closed.length };
  });
}

/** A card payment retired by `retireTestMode`: test money, which no longer counts. */
export const isRetiredTestPayment = (payment: { status: string; provider: string }) =>
  payment.status === "voided" && (TEST_PROCESSORS as readonly string[]).includes(payment.provider);
