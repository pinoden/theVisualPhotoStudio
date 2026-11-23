import { and, asc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { bookings, payments } from "@/db/schema";
import type { Db } from "@/db/client";
import { releaseExpiredHolds } from "./availability";
import { pruneRateLimits } from "./rate-limit";
import { noticeWaitlist } from "./waitlist";
import { dropUnfinishedVideos } from "./videos";
import { loadCatalog } from "./catalog";
import { deleteOldRecords } from "./retention";
import { durationLabel } from "@/lib/domain/time";
import { toBookingViews } from "./bookings";
import { bookingReminderEmail, deliverPendingEmails, loyaltyProgressEmail, queueEmail, reviewRequestEmail, type EmailTransport } from "./email";
import { runMembershipBilling } from "./memberships";
import { labelOf } from "@/lib/domain/labels";
import { BY_SYSTEM, recordEvent } from "./history";
import { loyaltyStandingOf, sendEarnedFreeHours } from "./loyalty";
import { checkUnsettledRefunds, finishWaitingEnds, retryOpenRefunds, type ManageDeps } from "./manage";
import { settleReservedPayments } from "./reserved";
import { checkOpenPayLinks } from "./pay-links";
import { emptyOldTrash } from "./pages";
import { loadAccessInstructions, loadSettings } from "./settings";
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
  /** Reminders queued for visits starting within the reminder's hours (`reminderHours`). */
  remindersQueued: number;
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
  /** Cancellations and releases the clients asked for that waited for the card processor, done now that the site knows (`finishWaitingEnds`). */
  waitingEndsFinished: number;
  /** Memberships' months found paid at the processor, recorded with their minutes (`runMembershipBilling`). */
  membershipMonthsPaid: number;
  /** Members told that a month was not paid, or that their payments stopped. */
  membershipProblems: number;
  /** Memberships whose buying stopped after their first month was paid, started now. */
  membershipsCarriedOn: number;
  emailsSent: number;
  emailsFailed: number;
  /** Pages removed for good from the trash, after the days a deleted page is kept. */
  pagesRemoved: number;
  /** Email copies, sign-in codes, ended sign-ins and access-log lines deleted for being older than `retentionYears`. */
  oldRecordsDeleted: number;
  /** Clients on the waitlist emailed that a time that fits has opened up (src/server/waitlist.ts). */
  waitlistEmailed: number;
  /** Uploads of videos never finished, a day on, dropped (src/server/videos.ts). */
  videoUploadsDropped: number;
}

const DAY = 86_400_000;

/**
 * The reminder before a visit (the owner's answer of 2026-11-17: 24 hours before). Each confirmed booking gets one,
 * once, when it starts within `reminderHours`, and only until it starts: a run that comes late still sends it while
 * it can help. A booking made inside those hours gets none, as its confirmation has only just gone; nor one waiting to
 * be moved, nor one the client asked to cancel or release that waits for the card processor (`endRequest`). How to get
 * in is the text the owners have set now, which may be newer than the confirmation's.
 */
export async function queueReminders(db: Db, now: Date): Promise<number> {
  const { reminderHours } = await loadSettings(db);
  if (reminderHours <= 0) return 0;
  const until = new Date(now.getTime() + reminderHours * 3_600_000);
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(bookings)
      .where(
        and(
          eq(bookings.status, "confirmed"),
          gt(bookings.startAt, now),
          lte(bookings.startAt, until),
          isNull(bookings.reminderSentAt),
          lte(bookings.createdAt, sql`${bookings.startAt} - make_interval(hours => ${reminderHours})`),
          or(isNull(bookings.label), ne(bookings.label, "reschedule_pending")),
          isNull(bookings.endRequestedAt),
        ),
      )
      .orderBy(asc(bookings.startAt), asc(bookings.id))
      .limit(100)
      .for("update", { skipLocked: true });
    if (due.length === 0) return 0;
    // One after the other: a transaction has a single connection (`together` in client.ts).
    const views = await toBookingViews(tx, due, now);
    const access = await loadAccessInstructions(tx);
    for (const [index, booking] of due.entries()) {
      const view = views[index];
      await queueEmail(
        tx,
        bookingReminderEmail({
          to: booking.customerEmail,
          name: booking.customerName,
          ref: booking.ref,
          studios: view.studios.map((studio) => studio.name).join(" + "),
          when: formatInstant(booking.startAt),
          duration: durationLabel(booking.durationMinutes),
          photoIncludes: booking.photographerId !== null ? (booking.photoIncludes ?? "") : undefined,
          service: view.photography?.service,
          dueCents: view.dueCents,
          atStudio: booking.madeBy !== null,
          access: access || undefined,
        }),
      );
      await tx.update(bookings).set({ reminderSentAt: now }).where(eq(bookings.id, booking.id));
    }
    return due.length;
  });
}

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
 * marked as a no-show is not completed, so it counts for nothing. A visit that
 * earned a stamp and no free hour gets the email of where the client stands
 * instead (`loyaltyProgressEmail`), once.
 */
export async function completeVisits(db: Db, now: Date, baseUrl: string): Promise<{ completed: number; codes: number }> {
  const settings = await loadSettings(db);
  const cutoff = new Date(now.getTime() - settings.loyaltyDelayHours * 3_600_000);

  // A booking waiting to be rescheduled is left alone: the client asked to move it, so the visit at the
  // original time did not happen, and an administrator decides what becomes of it. So is one the client asked to cancel
  // or release that waits for the card processor: it ends as they asked once the site knows (`finishWaitingEnds`).
  const done = await db.transaction(async (tx) => {
    const ended = await tx
      .select({ id: bookings.id, status: bookings.status, label: bookings.label })
      .from(bookings)
      .where(
        and(
          eq(bookings.status, "confirmed"),
          lte(bookings.endAt, cutoff),
          or(isNull(bookings.label), ne(bookings.label, "reschedule_pending")),
          isNull(bookings.endRequestedAt),
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
      // Claimed first, each visit once: a run beside this one (a retry) finds them claimed, and tells the client nothing twice.
      const claimed = (
        await tx
          .update(bookings)
          .set({ loyaltyIssuedAt: now })
          .where(and(inArray(bookings.id, customer.bookingIds), isNull(bookings.loyaltyIssuedAt)))
          .returning({ id: bookings.id })
      ).map((row) => row.id);
      const sent = await sendEarnedFreeHours(tx, { email, name: customer.name }, { now, baseUrl, settings });
      // A visit of these that earned its day's stamp, with no free hour coming of it: the client is told where they stand
      // (the owners' decision of 2026-11-20). A free hour sent says it all. One email for the visits of one run.
      if (sent === 0 && claimed.length > 0) {
        const standing = await loyaltyStandingOf(tx, email, settings);
        if (standing.towardsNext > 0 && claimed.some((id) => standing.days.some((day) => day.bookingId === id))) {
          await queueEmail(
            tx,
            loyaltyProgressEmail({
              to: email,
              name: customer.name,
              stamps: standing.towardsNext,
              visits: settings.loyaltyVisits,
              bookUrl: `${baseUrl.replace(/\/$/, "")}/book`,
            }),
          );
        }
      }
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
async function flagInterruptedPayments(db: Db): Promise<number> {
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
  const remindersQueued = await queueReminders(db, deps.now);
  const refundRuns = await retryOpenRefunds(db, deps);
  const settling = await checkUnsettledRefunds(db, deps);
  const links = await checkOpenPayLinks(db, deps);
  // After the links: one just found paid is counted in what the client asked for.
  const waitingEndsFinished = await finishWaitingEnds(db, deps);
  const billing = await runMembershipBilling(db, deps);
  // Before the emails go out, so that a time freed today reaches the waitlist in this run.
  const waitlistEmailed = await noticeWaitlist(db, await loadCatalog(db), { now: deps.now, baseUrl: deps.baseUrl });
  const mail = await deliverPendingEmails(db, deps.email, deps.now);
  const pagesRemoved = await emptyOldTrash(db, deps.now);
  await pruneRateLimits(db, deps.now);
  const old = await deleteOldRecords(db, deps.now, (await loadSettings(db)).retentionYears);
  const videoUploadsDropped = await dropUnfinishedVideos(db, deps.now);
  return {
    holdsReleased,
    paymentsFlagged,
    reservationsTaken: reservations.taken,
    reservationsReleased: reservations.released,
    visitsCompleted: visits.completed,
    loyaltyCodes: visits.codes,
    reviewRequestsQueued,
    remindersQueued,
    refundsSucceeded: refundRuns.succeeded,
    refundsFailed: refundRuns.failed,
    refundsSettled: settling.settled,
    refundsRejected: settling.rejected,
    payLinksPaid: links.paid,
    payLinksClosed: links.closed,
    waitingEndsFinished,
    membershipMonthsPaid: billing.monthsPaid,
    membershipProblems: billing.problems,
    membershipsCarriedOn: billing.carriedOn,
    emailsSent: mail.sent,
    emailsFailed: mail.failed,
    pagesRemoved,
    oldRecordsDeleted: old.emails + old.loginCodes + old.sessions + old.customerViews,
    waitlistEmailed,
    videoUploadsDropped,
  };
}
