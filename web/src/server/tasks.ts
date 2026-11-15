import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { bookings } from "@/db/schema";
import type { Db } from "@/db/client";
import { releaseExpiredHolds } from "./availability";
import { deliverPendingEmails, loyaltyCodeEmail, queueEmail, type EmailTransport } from "./email";
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

export async function runScheduledTasks(db: Db, deps: TaskDeps): Promise<TaskSummary> {
  const holdsReleased = await releaseExpiredHolds(db, deps.now);
  const visits = await completeVisits(db, deps.now, deps.baseUrl);
  const refundRuns = await retryOpenRefunds(db, deps);
  const mail = await deliverPendingEmails(db, deps.email, deps.now);
  return {
    holdsReleased,
    visitsCompleted: visits.completed,
    loyaltyCodes: visits.codes,
    refundsSucceeded: refundRuns.succeeded,
    refundsFailed: refundRuns.failed,
    emailsSent: mail.sent,
    emailsFailed: mail.failed,
  };
}
