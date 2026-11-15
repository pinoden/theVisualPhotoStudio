import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { bookings, payments } from "@/db/schema";
import type { Db } from "@/db/client";
import { releaseExpiredHolds } from "./availability";
import {
  deliverPendingEmails,
  loyaltyCodeEmail,
  ownerPaymentUnknownNotice,
  queueEmail,
  type EmailTransport,
} from "./email";
import { retryOpenRefunds, type ManageDeps } from "./manage";
import { issuePromo } from "./promos";
import { loadSettings } from "./settings";
import { formatInstant } from "./tz";

/**
 * Work that happens on a clock rather than on a request. `runScheduledTasks`
 * is called by GET /api/cron/tick, which a scheduler should hit every few
 * minutes. Every step is safe to run twice and safe to run late.
 */
export interface TaskDeps extends ManageDeps {
  email: EmailTransport | null;
}

export interface TaskSummary {
  holdsReleased: number;
  /** Payments whose result was never recorded; the owner was asked to check each. */
  paymentsFlagged: number;
  visitsCompleted: number;
  loyaltyCodes: number;
  refundsSucceeded: number;
  refundsFailed: number;
  emailsSent: number;
  emailsFailed: number;
}

const DAY = 86_400_000;

/**
 * Mark visits that ended a while ago as completed and thank the customer with
 * a loyalty code. A visit staff marked as a no-show gets nothing.
 */
export async function completeVisits(db: Db, now: Date, baseUrl: string): Promise<{ completed: number; codes: number }> {
  const settings = await loadSettings(db);
  const cutoff = new Date(now.getTime() - settings.loyaltyDelayHours * 3_600_000);

  const done = await db
    .update(bookings)
    .set({ status: "completed" })
    .where(and(eq(bookings.status, "confirmed"), lte(bookings.endAt, cutoff)))
    .returning({ id: bookings.id });

  if (!settings.loyaltyEnabled) return { completed: done.length, codes: 0 };

  // Includes visits staff marked completed by hand. Only recent ones, so
  // switching loyalty on does not mail everyone who ever visited.
  const due = await db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.status, "completed"),
        isNull(bookings.loyaltyIssuedAt),
        lte(bookings.endAt, cutoff),
        gt(bookings.endAt, new Date(now.getTime() - 7 * DAY)),
      ),
    )
    .limit(200);

  let codes = 0;
  for (const booking of due) {
    const issued = await db.transaction(async (tx) => {
      const expiresAt = new Date(now.getTime() + settings.loyaltyValidDays * DAY);
      const promo = await issuePromo(tx, {
        kind: "percent",
        value: settings.loyaltyPercent,
        source: "loyalty",
        email: booking.customerEmail,
        expiresAt,
        originBookingId: booking.id,
        note: `Thank-you code for ${booking.ref}`,
      });
      await tx.update(bookings).set({ loyaltyIssuedAt: now }).where(eq(bookings.id, booking.id));
      if (!promo) return false; // already issued for this visit
      await queueEmail(
        tx,
        loyaltyCodeEmail({
          to: booking.customerEmail,
          name: booking.customerName,
          code: promo.code,
          percent: settings.loyaltyPercent,
          expires: formatInstant(expiresAt),
          bookUrl: `${baseUrl.replace(/\/$/, "")}/book`,
        }),
      );
      return true;
    });
    if (issued) codes++;
  }
  return { completed: done.length, codes };
}

/**
 * A payment still marked pending on a booking that has expired means the
 * server stopped while the card was being charged, so nothing recorded how
 * the charge ended and the processor may have taken the money. Close the
 * record and ask the owner to look, once.
 */
export async function flagInterruptedPayments(db: Db, ownerEmail: string | null): Promise<number> {
  const stuck = await db
    .select({ id: payments.id, amountCents: payments.amountCents, ref: bookings.ref, customer: bookings.customerName })
    .from(payments)
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .where(and(eq(payments.status, "pending"), eq(bookings.status, "expired")))
    .limit(100);

  let flagged = 0;
  for (const row of stuck) {
    await db.transaction(async (tx) => {
      const closed = await tx
        .update(payments)
        .set({ status: "failed", error: "Interrupted: no result was recorded" })
        .where(and(eq(payments.id, row.id), eq(payments.status, "pending")))
        .returning({ id: payments.id });
      if (closed.length === 0) return; // another run closed it first
      flagged++;
      if (ownerEmail) {
        await queueEmail(
          tx,
          ownerPaymentUnknownNotice({
            to: ownerEmail,
            ref: row.ref,
            customer: row.customer,
            amountCents: row.amountCents,
            interrupted: true,
          }),
        );
      }
    });
  }
  return flagged;
}

export async function runScheduledTasks(db: Db, deps: TaskDeps): Promise<TaskSummary> {
  const holdsReleased = await releaseExpiredHolds(db, deps.now);
  const paymentsFlagged = await flagInterruptedPayments(db, deps.ownerEmail);
  const visits = await completeVisits(db, deps.now, deps.baseUrl);
  const refundRuns = await retryOpenRefunds(db, deps);
  const mail = await deliverPendingEmails(db, deps.email, deps.now);
  return {
    holdsReleased,
    paymentsFlagged,
    visitsCompleted: visits.completed,
    loyaltyCodes: visits.codes,
    refundsSucceeded: refundRuns.succeeded,
    refundsFailed: refundRuns.failed,
    emailsSent: mail.sent,
    emailsFailed: mail.failed,
  };
}
