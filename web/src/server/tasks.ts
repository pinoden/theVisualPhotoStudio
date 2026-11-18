import { and, asc, eq, gt, inArray, isNull, lte, ne, or } from "drizzle-orm";
import { bookings, payments } from "@/db/schema";
import type { Db } from "@/db/client";
import { releaseExpiredHolds } from "./availability";
import { deliverPendingEmails, queueEmail, reviewRequestEmail, type EmailTransport } from "./email";
import { labelOf } from "@/lib/domain/labels";
import { BY_SYSTEM, recordEvent } from "./history";
import { sendEarnedFreeHours } from "./loyalty";
import { checkUnsettledRefunds, retryOpenRefunds, type ManageDeps } from "./manage";
import { settleReservedPayments } from "./reserved";
import { checkOpenPayLinks } from "./pay-links";
import { emptyOldTrash } from "./pages";
import { loadSettings } from "./settings";

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
  /**
   * Payments whose result was never recorded (the server stopped while a card was being reserved), closed.
   * Nothing was taken: a reserved amount is given back by the processor by itself.
   */
  paymentsFlagged: number;
  /** Reserved amounts of bookings that stand, taken now. */
  reservationsTaken: number;
  /** Reserved amounts of bookings cancelled before the money was taken, given back. */
  reservationsReleased: number;
  visitsCompleted: number;
  /** Free hours sent to customers who reached five visits. */
  loyaltyCodes: number;
  reviewRequestsQueued: number;
  refundsSucceeded: number;
  refundsFailed: number;
  /** Refunds the processor had accepted as pending, found complete now. */
  refundsSettled: number;
  /** Refunds the processor had accepted, found rejected after all: the owner was told. */
  refundsRejected: number;
  /** Payment links found paid at the processor and recorded as payments. */
  payLinksPaid: number;
  /** Payment links withdrawn because their booking is no longer active. */
  payLinksClosed: number;
  emailsSent: number;
  emailsFailed: number;
  /** Pages removed for good from the trash, after the days a deleted page is kept. */
  pagesRemoved: number;
}

const DAY = 86_400_000;

async function queueReviewRequests(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - DAY);
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: bookings.id, ref: bookings.ref, email: bookings.customerEmail, name: bookings.customerName })
      .from(bookings)
      .where(and(eq(bookings.status, "completed"), lte(bookings.endAt, cutoff), isNull(bookings.reviewRequestedAt)))
      .orderBy(asc(bookings.endAt), asc(bookings.id))
      .limit(100)
      .for("update", { skipLocked: true });
    for (const booking of due) {
      await queueEmail(tx, reviewRequestEmail(booking));
      await tx.update(bookings).set({ reviewRequestedAt: now }).where(eq(bookings.id, booking.id));
    }
    return due.length;
  });
}

/**
 * Mark visits that ended a while ago as completed, and send a free hour to
 * each customer whose visits have earned one (see `loyalty.ts`). A visit staff
 * marked as a no-show is not completed, so it counts for nothing.
 */
export async function completeVisits(db: Db, now: Date, baseUrl: string): Promise<{ completed: number; codes: number }> {
  const settings = await loadSettings(db);
  const cutoff = new Date(now.getTime() - settings.loyaltyDelayHours * 3_600_000);

  // A booking waiting to be rescheduled is left alone: the client asked to move it, so the visit at the
  // original time did not happen, and an administrator decides what becomes of it.
  const done = await db.transaction(async (tx) => {
    const ended = await tx
      .select({ id: bookings.id, status: bookings.status, label: bookings.label })
      .from(bookings)
      .where(
        and(
          eq(bookings.status, "confirmed"),
          lte(bookings.endAt, cutoff),
          or(isNull(bookings.label), ne(bookings.label, "reschedule_pending")),
        ),
      )
      .for("update");
    if (ended.length === 0) return ended;
    await tx
      .update(bookings)
      .set({ status: "completed", label: null })
      .where(
        inArray(
          bookings.id,
          ended.map((booking) => booking.id),
        ),
      );
    for (const booking of ended) {
      await recordEvent(tx, { bookingId: booking.id, from: labelOf(booking), to: "completed", actor: BY_SYSTEM, at: now });
    }
    return ended;
  });

  if (!settings.loyaltyEnabled) return { completed: done.length, codes: 0 };

  // Visits not yet looked at for loyalty, including ones staff marked
  // completed by hand. Only recent ones, so switching loyalty on does not mail
  // everyone who ever visited: a customer is looked at when they next visit.
  const due = await db
    .select({ id: bookings.id, email: bookings.customerEmail, name: bookings.customerName })
    .from(bookings)
    .where(
      and(
        eq(bookings.status, "completed"),
        isNull(bookings.loyaltyIssuedAt),
        lte(bookings.endAt, cutoff),
        gt(bookings.endAt, new Date(now.getTime() - 7 * DAY)),
      ),
    )
    .orderBy(asc(bookings.endAt))
    .limit(200);

  // One customer at a time: all their visits are counted together, and what they have earned is sent once.
  const customers = new Map<string, { name: string; bookingIds: string[] }>();
  for (const booking of due) {
    const customer = customers.get(booking.email) ?? { name: booking.name, bookingIds: [] };
    customer.name = booking.name; // the name on their latest visit
    customer.bookingIds.push(booking.id);
    customers.set(booking.email, customer);
  }

  let codes = 0;
  for (const [email, customer] of customers) {
    codes += await db.transaction(async (tx) => {
      const sent = await sendEarnedFreeHours(tx, { email, name: customer.name }, { now, baseUrl, settings });
      await tx.update(bookings).set({ loyaltyIssuedAt: now }).where(inArray(bookings.id, customer.bookingIds));
      return sent;
    });
  }
  return { completed: done.length, codes };
}

/**
 * A payment still marked pending on a booking that has expired means the
 * server stopped while the card was being charged, so nothing recorded how
 * the charge ended and the processor may have taken the money. Close the
 * record and ask the owner to look, once.
 */
export async function flagInterruptedPayments(db: Db): Promise<number> {
  const stuck = await db
    .select({ id: payments.id, amountCents: payments.amountCents, ref: bookings.ref, customer: bookings.customerName })
    .from(payments)
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .where(and(eq(payments.status, "pending"), eq(bookings.status, "expired")))
    .limit(100);

  let flagged = 0;
  for (const row of stuck) {
    // Nothing to tell anyone: the card was at most reserved, and the processor gives that back by itself.
    const closed = await db
      .update(payments)
      .set({ status: "failed", error: "Interrupted before its result was recorded. Nothing was taken: a reserved amount is given back by Square by itself." })
      .where(and(eq(payments.id, row.id), eq(payments.status, "pending")))
      .returning({ id: payments.id });
    flagged += closed.length;
  }
  return flagged;
}

export async function runScheduledTasks(db: Db, deps: TaskDeps): Promise<TaskSummary> {
  const holdsReleased = await releaseExpiredHolds(db, deps.now);
  const paymentsFlagged = await flagInterruptedPayments(db);
  const reservations = await settleReservedPayments(db, deps);
  const visits = await completeVisits(db, deps.now, deps.baseUrl);
  const reviewRequestsQueued = await queueReviewRequests(db, deps.now);
  const refundRuns = await retryOpenRefunds(db, deps);
  const settling = await checkUnsettledRefunds(db, deps);
  const links = await checkOpenPayLinks(db, deps);
  const mail = await deliverPendingEmails(db, deps.email, deps.now);
  const pagesRemoved = await emptyOldTrash(db, deps.now);
  return {
    holdsReleased,
    paymentsFlagged,
    reservationsTaken: reservations.taken,
    reservationsReleased: reservations.released,
    visitsCompleted: visits.completed,
    loyaltyCodes: visits.codes,
    reviewRequestsQueued,
    refundsSucceeded: refundRuns.succeeded,
    refundsFailed: refundRuns.failed,
    refundsSettled: settling.settled,
    refundsRejected: settling.rejected,
    payLinksPaid: links.paid,
    payLinksClosed: links.closed,
    emailsSent: mail.sent,
    emailsFailed: mail.failed,
    pagesRemoved,
  };
}
