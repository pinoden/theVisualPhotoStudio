import { and, asc, eq, gt, inArray, isNull, lte, ne, or } from "drizzle-orm";
import { bookings, payments } from "@/db/schema";
import type { Db } from "@/db/client";
import { releaseExpiredHolds } from "./availability";
import { deliverPendingEmails, ownerPaymentUnknownNotice, queueEmail, type EmailTransport } from "./email";
import { labelOf } from "@/lib/domain/labels";
import { BY_SYSTEM, recordEvent } from "./history";
import { sendEarnedFreeHours } from "./loyalty";
import { retryOpenRefunds, type ManageDeps } from "./manage";
import { checkOpenPayLinks } from "./pay-links";
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
  /** Payments whose result was never recorded; the owner was asked to check each. */
  paymentsFlagged: number;
  visitsCompleted: number;
  /** Free hours sent to customers who reached five visits. */
  loyaltyCodes: number;
  refundsSucceeded: number;
  refundsFailed: number;
  /** Payment links found paid at the processor and recorded as payments. */
  payLinksPaid: number;
  /** Payment links withdrawn because their booking is no longer active. */
  payLinksClosed: number;
  emailsSent: number;
  emailsFailed: number;
}

const DAY = 86_400_000;

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
  const links = await checkOpenPayLinks(db, deps);
  const mail = await deliverPendingEmails(db, deps.email, deps.now);
  return {
    holdsReleased,
    paymentsFlagged,
    visitsCompleted: visits.completed,
    loyaltyCodes: visits.codes,
    refundsSucceeded: refundRuns.succeeded,
    refundsFailed: refundRuns.failed,
    payLinksPaid: links.paid,
    payLinksClosed: links.closed,
    emailsSent: mail.sent,
    emailsFailed: mail.failed,
  };
}
