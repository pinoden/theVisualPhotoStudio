import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { bookings, paymentLinks, payments, refunds, studioHolds, studios } from "@/db/schema";
import { PG_UNIQUE_VIOLATION, pgErrorCode, type Db, type DbLike } from "@/db/client";
import { labelOf } from "@/lib/domain/labels";
import { formatCents } from "@/lib/domain/pricing";
import { can } from "@/lib/abilities";
import type { AuthUser } from "./auth";
import { isBookingRef } from "./bookings";
import { latePaymentEmail, payLinkEmail, paymentReceivedEmail, queueEmail, replaceQueuedEmail } from "./email";
import { BY_CUSTOMER, BY_SYSTEM, recordEvent } from "./history";
import { receivedCentsByBooking } from "./money";
import type { PaymentProvider } from "./payments";
import { loadSettings } from "./settings";
import { canViewDay } from "./staff";
import { formatInstant, localDateOf } from "./tz";

/**
 * A payment link: a page of the card processor where a client pays, by card,
 * what a booking made in the admin still owes. The owner's answer of
 * 2026-11-15: "add an option to send them a payment link to Square".
 *
 * How it goes:
 *  1. An administrator presses "Email a payment link". The processor makes a
 *     link for exactly what the booking owes, and the client is emailed the
 *     address of a page on this site (`/pay/<id>`), which leads to it.
 *  2. The client pays on the processor's page and is sent back to that page.
 *  3. The site asks the processor whether the link was paid: when the client
 *     comes back, when an administrator presses "Check", and from the
 *     scheduled task. A paid link becomes an ordinary card payment on the
 *     booking, so it is refunded like any other.
 *
 * One booking has at most one open link (the database enforces it), and
 * while one is open no payment can be recorded by hand: the client could
 * otherwise pay twice. Verified against Square's sandbox on 2026-11-15.
 */

type BookingRow = typeof bookings.$inferSelect;
type LinkRow = typeof paymentLinks.$inferSelect;

export interface PayLinkDeps {
  now: Date;
  /** Site origin: the client is sent to a page of this site, which leads to the processor's. */
  baseUrl: string;
  /** null when no processor is configured: no link can be made. */
  payments: PaymentProvider | null;
  /** Where the notice of a refund goes: a payment that arrives for a booking no longer active is refunded. */
  ownerEmail?: string | null;
}

/** A booking that can still be paid for: money that arrives for any other is given back. */
const ACTIVE = ["confirmed", "completed", "no_show"];

export interface PayLinkView {
  id: string;
  amountCents: number;
  status: "open" | "paid" | "cancelled";
  createdBy: string;
  createdAt: string;
  /** The processor that made it (`PaymentProvider.name`): one that is not the processor set up now cannot be paid or asked about. */
  provider: string;
}

/** The address the client is emailed: a page of this site that shows what is owed and leads to the processor. */
export function payPageUrl(baseUrl: string, linkId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/pay/${linkId}`;
}

/** The link a booking has open, if any. */
export async function openPayLinkOf(db: DbLike, bookingId: string): Promise<PayLinkView | null> {
  const [row] = await db
    .select()
    .from(paymentLinks)
    .where(and(eq(paymentLinks.bookingId, bookingId), eq(paymentLinks.status, "open")))
    .limit(1);
  return row ? view(row) : null;
}

function view(row: LinkRow): PayLinkView {
  return {
    id: row.id,
    amountCents: row.amountCents,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    provider: row.provider,
  };
}

/** What a booking still owes: its price less every payment that succeeded. */
async function dueCentsOf(db: DbLike, booking: Pick<BookingRow, "id" | "totalCents" | "madeBy">): Promise<number> {
  if (booking.madeBy === null) return 0; // a booking made online is paid when it is made
  const received = (await receivedCentsByBooking(db, [booking.id])).get(booking.id) ?? 0;
  return Math.max(0, booking.totalCents - received);
}

async function studioNamesOf(db: DbLike, bookingId: string): Promise<string> {
  const rows = await db
    .select({ name: studios.name })
    .from(studioHolds)
    .innerJoin(studios, eq(studios.id, studioHolds.studioId))
    .where(eq(studioHolds.bookingId, bookingId))
    .orderBy(asc(studios.sortOrder));
  return rows.map((row) => row.name).join(" + ");
}

export type SendPayLinkBlock =
  | "forbidden"
  | "not_found"
  | "not_active"
  | "nothing_due"
  | "no_processor"
  | "other_amount_open"
  | "other_processor_open"
  | "processor_refused";

export type SendPayLinkResult =
  | { ok: true; amountCents: number; /** True when a link already open was emailed again, and no new one was made. */ again: boolean }
  | { ok: false; reason: SendPayLinkBlock; message: string };

const refuse = (reason: SendPayLinkBlock, message: string) => ({ ok: false as const, reason, message });

/**
 * Email the client a link to pay what their booking still owes. Pressing it
 * again while the link is open emails the same link again.
 */
export async function sendPayLink(db: Db, viewer: AuthUser, ref: string, deps: PayLinkDeps): Promise<SendPayLinkResult> {
  const settings = await loadSettings(db);
  if (!can(viewer, "recordPayments", settings)) return refuse("forbidden", "You cannot send payment links.");
  if (!isBookingRef(ref)) return refuse("not_found", "Booking not found.");
  const [booking] = await db.select().from(bookings).where(eq(bookings.ref, ref)).limit(1);
  // Staff are told "forbidden" for an unknown reference too, so they cannot probe for bookings.
  if (!booking) return viewer.role === "owner" ? refuse("not_found", "Booking not found.") : refuse("forbidden", "You cannot send a payment link for that booking.");
  if (!(await canViewDay(db, viewer, localDateOf(booking.startAt)))) return refuse("forbidden", "You cannot send a payment link for that booking.");
  if (!["confirmed", "completed", "no_show"].includes(booking.status)) {
    return refuse("not_active", "A payment link can be sent for a booking that is confirmed or has taken place, not for a cancelled one.");
  }
  const dueCents = await dueCentsOf(db, booking);
  if (dueCents <= 0) return refuse("nothing_due", "Nothing is owed for this booking.");

  const email = (linkId: string) =>
    queueEmail(
      db,
      payLinkEmail({
        to: booking.customerEmail,
        name: booking.customerName,
        ref: booking.ref,
        when: formatInstant(booking.startAt),
        amountCents: dueCents,
        payUrl: payPageUrl(deps.baseUrl, linkId),
      }),
    );

  const open = await openPayLinkOf(db, booking.id);
  if (open) {
    // A link the processor set up now did not make (one of test mode, left after the real keys went in) cannot be paid.
    if ((deps.payments?.name ?? null) !== open.provider) {
      return refuse(
        "other_processor_open",
        "The open payment link of this booking was made by another card processor than the one set up now (in test mode, or with other keys), so it cannot be paid. An owner closes it by hand first; then a new one can be emailed.",
      );
    }
    if (open.amountCents !== dueCents) {
      return refuse(
        "other_amount_open",
        `A payment link for ${formatCents(open.amountCents)} is still open, and the booking now owes ${formatCents(dueCents)}. Cancel that link first.`,
      );
    }
    await email(open.id);
    return { ok: true, amountCents: dueCents, again: true };
  }

  if (!deps.payments) return refuse("no_processor", "Card payments are not set up, so no payment link can be made.");
  const id = randomUUID();
  const made = await deps.payments.createPayLink({
    amountCents: dueCents,
    idempotencyKey: id,
    title: `Booking ${booking.ref}: ${await studioNamesOf(db, booking.id)}, ${formatInstant(booking.startAt)}`,
    note: `${booking.ref} ${booking.customerName}`,
    returnUrl: payPageUrl(deps.baseUrl, id),
  });
  if (!made.ok) return refuse("processor_refused", `The payment link could not be made: ${made.message}`);

  try {
    await db.transaction(async (tx) => {
      await tx.insert(paymentLinks).values({
        id,
        bookingId: booking.id,
        provider: deps.payments!.name,
        providerLinkId: made.linkId,
        providerOrderId: made.orderId,
        url: made.url,
        amountCents: dueCents,
        createdBy: viewer.email,
        createdAt: deps.now,
      });
      const label = labelOf(booking);
      await recordEvent(tx, {
        bookingId: booking.id,
        from: label,
        to: label,
        actor: viewer.email,
        at: deps.now,
        note: `Payment link for ${formatCents(dueCents)} emailed to the client`,
      });
    });
  } catch (error) {
    // Someone else sent a link for this booking in the same moment: theirs stands, and this one is withdrawn.
    if (pgErrorCode(error) !== PG_UNIQUE_VIOLATION) throw error;
    await deps.payments.cancelPayLink(made.linkId).catch(() => undefined);
    const theirs = await openPayLinkOf(db, booking.id);
    if (theirs) await email(theirs.id);
    return { ok: true, amountCents: dueCents, again: true };
  }
  await email(id);
  return { ok: true, amountCents: dueCents, again: false };
}

/**
 * Turn a paid link into a payment on its booking. Safe to call twice and
 * from two places at once: the link is claimed first, and only the caller
 * that claims it writes the payment. Returns whether this call did.
 */
/**
 * Record a link's payment on its booking. One that arrives for a booking that
 * is no longer active (cancelled, or released for a reschedule code, while
 * the client was paying) is refunded to the card in full at once: the
 * cancellation, or the code, was worked out without it. Answers whether it
 * was recorded, and the refund to send when it is given back.
 */
type LateRefund = { refundId: string; emailId: string; email: Omit<Parameters<typeof latePaymentEmail>[0], "state"> };

/** The reason of the refund of a payment that arrived after its booking ended, by which it is told from any other. */
const lateReason = (ref: string, ended: string) => `Paid after ${ref} ${ended}`;

/**
 * The refund `settle` made of a link's payment that arrived after its booking
 * ended, if there is one: whether the processor took it, or it has not
 * reached the card yet (waiting, or failed and tried again). Any other refund
 * of the same payment is a cancellation's or an owner's, and is not this.
 */
async function lateRefundOf(db: DbLike, paymentId: string, ref: string): Promise<{ made: boolean } | null> {
  const [refund] = await db
    .select({ status: refunds.status })
    .from(refunds)
    .where(and(eq(refunds.paymentId, paymentId), eq(refunds.automatic, true), sql`starts_with(${refunds.reason}, ${lateReason(ref, "")})`))
    .limit(1);
  return refund ? { made: refund.status === "succeeded" } : null;
}

async function settle(db: Db, link: LinkRow, paid: { paymentId: string; amountCents: number }, now: Date): Promise<{ settled: boolean; late?: LateRefund }> {
  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(paymentLinks)
      .set({ status: "paid", paidAt: now })
      .where(and(eq(paymentLinks.id, link.id), eq(paymentLinks.status, "open")))
      .returning({ id: paymentLinks.id });
    if (claimed.length === 0) return { settled: false };

    const [booking] = await tx.select().from(bookings).where(eq(bookings.id, link.bookingId)).for("update").limit(1);
    const [payment] = await tx
      .insert(payments)
      .values({
        bookingId: link.bookingId,
        provider: link.provider,
        providerPaymentId: paid.paymentId,
        amountCents: paid.amountCents,
        status: "succeeded",
        note: "Paid by card through the payment link",
        createdAt: now,
      })
      .returning({ id: payments.id });
    await tx.update(paymentLinks).set({ paymentId: payment.id }).where(eq(paymentLinks.id, link.id));

    const label = labelOf(booking);
    if (!ACTIVE.includes(booking.status)) {
      const released = booking.cancelReason === "rescheduled";
      const ended = released ? "was released for a reschedule code" : "was cancelled";
      const [refund] = await tx
        .insert(refunds)
        .values({ paymentId: payment.id, amountCents: paid.amountCents, reason: lateReason(booking.ref, ended), automatic: true, status: "pending" })
        .returning({ id: refunds.id });
      await recordEvent(tx, {
        bookingId: booking.id,
        from: label,
        to: label,
        actor: BY_SYSTEM,
        at: now,
        note: `Payment of ${formatCents(paid.amountCents)} received through the payment link after the booking ${ended}; it is refunded to the card in full`,
      });
      // Said as sent; put right if the refund does not go through (`giveBackLate`).
      const email = { to: booking.customerEmail, name: booking.customerName, ref: booking.ref, amountCents: paid.amountCents, released };
      const emailId = await queueEmail(tx, latePaymentEmail({ ...email, state: "sent" }));
      return { settled: true, late: { refundId: refund.id, emailId, email } };
    }

    const dueCents = await dueCentsOf(tx, booking);
    await recordEvent(tx, {
      bookingId: booking.id,
      from: label,
      to: label,
      actor: BY_CUSTOMER,
      at: now,
      note: `Payment of ${formatCents(paid.amountCents)} received through the payment link${
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
        amountCents: paid.amountCents,
        method: "Card, through the payment link",
        dueCents,
        online: true,
      }),
    );
    return { settled: true };
  });
}

/**
 * Send the refund of a payment that arrived too late (`settle`). When it does
 * not go through, its email says so, as a cancellation's does; left waiting,
 * it is sent by the scheduled task.
 */
async function giveBackLate(db: Db, late: LateRefund | undefined, deps: PayLinkDeps): Promise<void> {
  if (!late) return;
  // Imported here: manage.ts withdraws a booking's link through this module.
  const { processRefund } = await import("./manage");
  const status = await processRefund(db, late.refundId, { now: deps.now, payments: deps.payments, ownerEmail: deps.ownerEmail ?? null, baseUrl: deps.baseUrl });
  if (status === "succeeded") return;
  const notYet = latePaymentEmail({ ...late.email, state: "not_yet" });
  if (!(await replaceQueuedEmail(db, late.emailId, notYet))) await queueEmail(db, notYet);
}

/**
 * For a client's account: record the payment links of their active bookings
 * that were paid and not seen yet, before the account says what cancelling or
 * moving would do (`noticePaidLink`).
 */
export async function noticePaidLinksOf(db: Db, email: string, deps: PayLinkDeps, afterward?: (work: Promise<unknown>) => void): Promise<boolean> {
  const open = await db
    .select({ id: bookings.id, status: bookings.status })
    .from(paymentLinks)
    .innerJoin(bookings, eq(bookings.id, paymentLinks.bookingId))
    .where(and(eq(paymentLinks.status, "open"), eq(bookings.customerEmail, email.trim().toLowerCase())));
  // `lookAtPayLink` never throws, so the work can go on by itself once the page stops waiting for it. It answers
  // whether the link of a booking that stands could not be asked about.
  const work = (async () => {
    let unseen = false;
    for (const booking of open) {
      if ((await lookAtPayLink(db, booking, deps)) === "unanswered" && ACTIVE.includes(booking.status)) unseen = true;
    }
    return unseen;
  })();
  afterward?.(work);
  // True when the account shows a booking whose link nobody could say anything about in time (see `noticeBookingPayments`).
  const answer = await withinSeconds(PAGE_WAIT_SECONDS, work);
  return answer === undefined ? open.some((booking) => ACTIVE.includes(booking.status)) : answer;
}

/** What became of a booking's open payment link when the processor was asked: `none` when it had none. */
export type LinkLook = "none" | "open" | "paid" | "cancelled" | "unanswered" | "unknown";

/**
 * How long a page waits for the processor before it is drawn without its
 * answer. The processor's own calls wait up to 10 seconds each, and are tried
 * three times: a client is not kept looking at an empty page meanwhile.
 */
export const PAGE_WAIT_SECONDS = 4;

/** Waits for `work` at most `seconds`, and then answers undefined; the work goes on by itself, and must not throw. */
export async function withinSeconds<T>(seconds: number, work: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), seconds * 1000);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A booking's open payment link, as a page about the booking or a change to
 * it finds it: while the booking is active, a payment made on the
 * processor's page is recorded (`noticePaidLink`); once it is not, the link is
 * withdrawn, so that nobody pays for it any more (and recorded, should it have
 * been paid after all). Never throws.
 */
export async function lookAtPayLink(db: Db, booking: { id: string; status: string }, deps: PayLinkDeps): Promise<LinkLook> {
  if (ACTIVE.includes(booking.status)) return noticePaidLink(db, booking.id, deps);
  try {
    const [link] = await db
      .select()
      .from(paymentLinks)
      .where(and(eq(paymentLinks.bookingId, booking.id), eq(paymentLinks.status, "open")))
      .limit(1);
    if (!link) return "none";
    const result = await withdraw(db, link, deps, BY_SYSTEM);
    return result.ok ? (result.outcome === "was_paid" ? "paid" : "cancelled") : "unanswered";
  } catch (error) {
    console.error("Could not withdraw the payment link of booking", booking.id, error);
    return "unanswered";
  }
}

/**
 * Before a booking is cancelled or released for a reschedule code: ask the
 * processor whether its open link was paid, and record the payment while the
 * booking is still active, so that what is decided counts it (the terms of a
 * cancellation, a code's value). Answers what the processor said:
 * `unanswered` when it could not say, so that a client's change waits for
 * it; the studio's own cancellation goes ahead, and the link is withdrawn
 * afterwards, as before.
 */
export async function noticePaidLink(db: Db, bookingId: string, deps: PayLinkDeps): Promise<LinkLook> {
  try {
    const [link] = await db
      .select({ id: paymentLinks.id })
      .from(paymentLinks)
      .where(and(eq(paymentLinks.bookingId, bookingId), eq(paymentLinks.status, "open")))
      .limit(1);
    return link ? await checkPayLink(db, link.id, deps) : "none";
  } catch (error) {
    console.error("Could not ask whether the payment link of booking", bookingId, "was paid", error);
    return "unanswered";
  }
}

/**
 * Ask the processor whether an open link was paid, and record it if so.
 * Returns the link's status afterwards: "open" also when no processor is set
 * up to ask, because nothing is known to have changed; "unanswered" when the
 * processor was asked and could not say, so that the link may have been paid;
 * "unknown" for an address that is no link.
 */
export async function checkPayLink(db: Db, linkId: string, deps: PayLinkDeps): Promise<"open" | "paid" | "cancelled" | "unanswered" | "unknown"> {
  if (!/^[0-9a-f-]{36}$/i.test(linkId)) return "unknown";
  const [link] = await db.select().from(paymentLinks).where(eq(paymentLinks.id, linkId)).limit(1);
  if (!link) return "unknown";
  if (link.status !== "open") return link.status;
  // A link made by another processor than the one set up (one of test mode left after the real keys went in), or with
  // none set up now, cannot be asked about: as good as a processor that cannot say. It counts as asked, so that the
  // scheduled task moves on to the others.
  if (!deps.payments || deps.payments.name !== link.provider) {
    await db.update(paymentLinks).set({ checkedAt: deps.now }).where(eq(paymentLinks.id, link.id));
    return "unanswered";
  }

  const state = await deps.payments.payLinkState({ linkId: link.providerLinkId, orderId: link.providerOrderId });
  await db.update(paymentLinks).set({ checkedAt: deps.now }).where(eq(paymentLinks.id, link.id));
  if (state.state === "paid") {
    const { late } = await settle(db, link, state, deps.now);
    await giveBackLate(db, late, deps);
    return "paid";
  }
  if (state.state === "cancelled") {
    // Cancelled at the processor itself (an owner deleted it in Square): the history says so.
    await db.transaction(async (tx) => {
      const closed = await tx
        .update(paymentLinks)
        .set({ status: "cancelled", cancelledAt: deps.now })
        .where(and(eq(paymentLinks.id, link.id), eq(paymentLinks.status, "open")))
        .returning({ id: paymentLinks.id });
      if (closed.length === 0) return;
      const [booking] = await tx.select().from(bookings).where(eq(bookings.id, link.bookingId)).limit(1);
      const label = labelOf(booking);
      await recordEvent(tx, {
        bookingId: booking.id,
        from: label,
        to: label,
        actor: BY_SYSTEM,
        at: deps.now,
        note: `Payment link for ${formatCents(link.amountCents)} found cancelled at the card processor`,
      });
    });
    return "cancelled";
  }
  return state.state === "unknown" ? "unanswered" : "open";
}

/**
 * Why nothing could be learned about a link, for an administrator: the processor could not say, or the link is
 * another processor's. `withdrawing`: said when it was to be withdrawn, and so was not.
 */
function cannotAskText(link: LinkRow, deps: PayLinkDeps, withdrawing: boolean): string {
  const not = withdrawing ? ", so it was not withdrawn" : "";
  return deps.payments && deps.payments.name === link.provider
    ? `The card processor could not say whether the link was paid${not}. Try again in a moment. If it goes on, look the link up in Square: an owner can then close it here by hand.`
    : `This link was made by another card processor than the one set up now (in test mode, or with other keys), which the site cannot ask${not}. Look it up there: an owner can then close it here by hand.`;
}

/** `late`: paid for a booking that had ended, and so refunded in full (`made`), or due back (`lateRefundOf`). */
export type CancelPayLinkResult = { ok: true; outcome: "cancelled" | "was_paid"; late?: { made: boolean } } | { ok: false; message: string };

/**
 * Withdraw an open link at the processor, so that it can no longer be paid.
 * The processor is asked first whether it was paid in the meantime: a paid
 * link is recorded as paid, never cancelled.
 */
async function withdraw(db: Db, link: LinkRow, deps: PayLinkDeps, actor: string): Promise<CancelPayLinkResult> {
  const seen = await checkPayLink(db, link.id, deps);
  if (seen === "paid") return { ok: true, outcome: "was_paid" };
  // Already cancelled at the processor: nothing more to withdraw.
  if (seen === "cancelled") return { ok: true, outcome: "cancelled" };
  // Withdrawn only once the processor has said it was not paid: one it could not answer about may have been, and
  // its payment would be lost with it. The scheduled task asks again.
  if (seen !== "open" || !deps.payments) return { ok: false, message: cannotAskText(link, deps, true) };
  const gone = await deps.payments.cancelPayLink(link.providerLinkId);
  if (!gone.ok) return { ok: false, message: `The link could not be cancelled: ${gone.message}` };

  await db.transaction(async (tx) => {
    const closed = await tx
      .update(paymentLinks)
      .set({ status: "cancelled", cancelledAt: deps.now })
      .where(and(eq(paymentLinks.id, link.id), eq(paymentLinks.status, "open")))
      .returning({ id: paymentLinks.id });
    if (closed.length === 0) return;
    const [booking] = await tx.select().from(bookings).where(eq(bookings.id, link.bookingId)).limit(1);
    const label = labelOf(booking);
    await recordEvent(tx, {
      bookingId: booking.id,
      from: label,
      to: label,
      actor,
      at: deps.now,
      note: `Payment link for ${formatCents(link.amountCents)} cancelled`,
    });
  });
  return { ok: true, outcome: "cancelled" };
}

/** An administrator cancels the open link of a booking: to record cash instead, or because the amount changed. */
export async function cancelPayLink(db: Db, viewer: AuthUser, ref: string, deps: PayLinkDeps): Promise<CancelPayLinkResult> {
  const settings = await loadSettings(db);
  if (!can(viewer, "recordPayments", settings) || !isBookingRef(ref)) return { ok: false, message: "Booking not found." };
  const [booking] = await db.select().from(bookings).where(eq(bookings.ref, ref)).limit(1);
  if (!booking || !(await canViewDay(db, viewer, localDateOf(booking.startAt)))) return { ok: false, message: "Booking not found." };
  const [link] = await db
    .select()
    .from(paymentLinks)
    .where(and(eq(paymentLinks.bookingId, booking.id), eq(paymentLinks.status, "open")))
    .limit(1);
  if (!link) return { ok: false, message: "This booking has no open payment link." };
  return withdraw(db, link, deps, viewer.email);
}

/**
 * An owner closes an open link that the processor cannot say anything about
 * (a link it no longer knows: made with other keys, or for another location),
 * once they have looked it up in Square and found it unpaid. The site then
 * stops asking about it, and a payment can be recorded by hand. A link the
 * processor can answer about is withdrawn the usual way, or recorded as paid.
 * The owner's decision, written into the booking's history: a link is
 * otherwise never marked cancelled unless the processor confirmed it.
 */
export async function closePayLinkByHand(db: Db, viewer: AuthUser, ref: string, deps: PayLinkDeps): Promise<CancelPayLinkResult> {
  if (viewer.role !== "owner" || !isBookingRef(ref)) return { ok: false, message: "Booking not found." };
  const [booking] = await db.select().from(bookings).where(eq(bookings.ref, ref)).limit(1);
  if (!booking) return { ok: false, message: "Booking not found." };
  const [link] = await db
    .select()
    .from(paymentLinks)
    .where(and(eq(paymentLinks.bookingId, booking.id), eq(paymentLinks.status, "open")))
    .limit(1);
  if (!link) return { ok: false, message: "This booking has no open payment link." };
  const seen = await checkPayLink(db, link.id, deps);
  if (seen === "paid") {
    // Paid for a booking that had ended: `settle` gave it back, or is to, and the owner is told which.
    if (ACTIVE.includes(booking.status)) return { ok: true, outcome: "was_paid" };
    const [paid] = await db.select({ paymentId: paymentLinks.paymentId }).from(paymentLinks).where(eq(paymentLinks.id, link.id)).limit(1);
    const late = paid?.paymentId ? await lateRefundOf(db, paid.paymentId, booking.ref) : null;
    return { ok: true, outcome: "was_paid", ...(late ? { late } : {}) };
  }
  // Found cancelled at the processor (deleted in Square, as the page asks): closed, with its line in the history.
  if (seen === "cancelled") return { ok: true, outcome: "cancelled" };
  if (seen !== "unanswered") return withdraw(db, link, deps, viewer.email);
  // Tried at the processor too, when it is the link's own, for what it is worth: the link is closed here whatever it answers.
  if (deps.payments && deps.payments.name === link.provider) {
    try {
      await deps.payments.cancelPayLink(link.providerLinkId);
    } catch (error) {
      console.error("Could not withdraw the payment link of booking", booking.ref, "at the processor", error);
    }
  }
  await db.transaction(async (tx) => {
    const closed = await tx
      .update(paymentLinks)
      .set({ status: "cancelled", cancelledAt: deps.now })
      .where(and(eq(paymentLinks.id, link.id), eq(paymentLinks.status, "open")))
      .returning({ id: paymentLinks.id });
    if (closed.length === 0) return;
    const label = labelOf(booking);
    await recordEvent(tx, {
      bookingId: booking.id,
      from: label,
      to: label,
      actor: viewer.email,
      at: deps.now,
      note: `Payment link for ${formatCents(link.amountCents)} closed by hand: the card processor could not say whether it was paid, and the owner looked it up at the processor`,
    });
  });
  return { ok: true, outcome: "cancelled" };
}

/** An administrator asks, for a booking's open link, whether it has been paid. A paid link is recorded at once. */
export async function checkBookingPayLink(
  db: Db,
  viewer: AuthUser,
  ref: string,
  deps: PayLinkDeps,
): Promise<{ ok: true; status: "open" | "paid" | "cancelled"; late?: { made: boolean } } | { ok: false; message: string }> {
  const settings = await loadSettings(db);
  if (!can(viewer, "recordPayments", settings) || !isBookingRef(ref)) return { ok: false, message: "Booking not found." };
  const [booking] = await db.select().from(bookings).where(eq(bookings.ref, ref)).limit(1);
  if (!booking || !(await canViewDay(db, viewer, localDateOf(booking.startAt)))) return { ok: false, message: "Booking not found." };
  const open = await openPayLinkOf(db, booking.id);
  if (!open) return { ok: false, message: "This booking has no open payment link." };
  const status = await checkPayLink(db, open.id, deps);
  if (status === "unknown") return { ok: false, message: "The payment link could not be checked." };
  if (status === "unanswered") {
    const [link] = await db.select().from(paymentLinks).where(eq(paymentLinks.id, open.id)).limit(1);
    return { ok: false, message: cannotAskText(link, deps, false) };
  }
  if (status !== "paid" || ACTIVE.includes(booking.status)) return { ok: true, status };
  // Paid for a booking no longer active: `settle` gave it back, or is to.
  const [link] = await db.select({ paymentId: paymentLinks.paymentId }).from(paymentLinks).where(eq(paymentLinks.id, open.id)).limit(1);
  const late = link?.paymentId ? await lateRefundOf(db, link.paymentId, booking.ref) : null;
  return { ok: true, status, ...(late ? { late } : {}) };
}

/**
 * A booking stopped being active (cancelled, released for a reschedule
 * code): its open link is withdrawn, so that nobody pays for it afterwards.
 * Never throws: the cancellation it follows has already happened, and the
 * scheduled task tries again.
 */
export async function closePayLinkOf(db: Db, bookingId: string, deps: PayLinkDeps): Promise<void> {
  try {
    const [link] = await db
      .select()
      .from(paymentLinks)
      .where(and(eq(paymentLinks.bookingId, bookingId), eq(paymentLinks.status, "open")))
      .limit(1);
    if (link) await withdraw(db, link, deps, BY_SYSTEM);
  } catch (error) {
    console.error("Could not withdraw the payment link of booking", bookingId, error);
  }
}

/**
 * The scheduled look at every open link: record the ones that were paid, and
 * withdraw the ones whose booking is no longer active. Safe to run twice.
 */
export async function checkOpenPayLinks(db: Db, deps: PayLinkDeps, limit = 50): Promise<{ paid: number; closed: number }> {
  const open = await db
    .select({ link: paymentLinks, status: bookings.status })
    .from(paymentLinks)
    .innerJoin(bookings, eq(bookings.id, paymentLinks.bookingId))
    .where(eq(paymentLinks.status, "open"))
    // The longest unasked first: links the processor cannot answer about never keep the others waiting.
    .orderBy(sql`${paymentLinks.checkedAt} asc nulls first`, asc(paymentLinks.createdAt))
    .limit(limit);
  let paid = 0;
  let closed = 0;
  for (const { link, status } of open) {
    if (["confirmed", "completed", "no_show"].includes(status)) {
      if ((await checkPayLink(db, link.id, deps)) === "paid") paid++;
    } else {
      const result = await withdraw(db, link, deps, BY_SYSTEM);
      if (result.ok && result.outcome === "was_paid") paid++;
      else if (result.ok) closed++;
    }
  }
  return { paid, closed };
}

/** What the page a client is emailed shows. Null for an address that is no link. */
export interface PayPage {
  id: string;
  /**
   * `refunded`: paid after the booking had ended, and given back in full (`late` says how far that has gone).
   * `closed`: the booking has ended, so nothing is to be paid here, whether or not the link was withdrawn yet.
   */
  status: "open" | "paid" | "cancelled" | "refunded" | "closed";
  /** For `refunded`: how the booking ended, and whether the refund was made or has not reached the card yet. */
  late: { released: boolean; made: boolean } | null;
  /** For `closed`: whether the booking was released for a reschedule code rather than cancelled. */
  closed: { released: boolean } | null;
  amountCents: number;
  ref: string;
  studios: string;
  /** The booking's start, as the studio's clock shows it. */
  when: string;
  /** The processor's page, while the link is open. */
  processorUrl: string | null;
  /** True for the pretend processor of development and test mode: the page then offers a pretend payment. */
  pretend: boolean;
}

/**
 * The page behind the link in the client's email. Opening it asks the
 * processor whether the link was paid, so a client who has just paid and is
 * sent back sees that it arrived. It shows the booking's reference, studios,
 * time and amount, and nothing else about the client: the address is known
 * only to whoever was emailed it.
 */
export async function getPayPage(db: Db, linkId: string, deps: PayLinkDeps): Promise<PayPage | null> {
  if (!/^[0-9a-f-]{36}$/i.test(linkId)) return null;
  const read = async () =>
    (
      await db
        .select({ link: paymentLinks, booking: bookings })
        .from(paymentLinks)
        .innerJoin(bookings, eq(bookings.id, paymentLinks.bookingId))
        .where(eq(paymentLinks.id, linkId))
        .limit(1)
    )[0];
  const first = await read();
  if (!first) return null;
  // A client sent back from paying sees that it arrived; the link of a booking that has ended is withdrawn.
  await lookAtPayLink(db, first.booking, deps);
  const row = (await read()) ?? first;
  const ended = !ACTIVE.includes(row.booking.status);
  const released = row.booking.cancelReason === "rescheduled";
  // Paid for a booking that had ended: `settle` gave it back, and the page says so. A payment that counted while the
  // booking was active stays "paid", whatever a cancellation refunded of it later: that is the cancellation's to tell.
  const back = row.link.status === "paid" && ended && row.link.paymentId ? await lateRefundOf(db, row.link.paymentId, row.booking.ref) : null;
  // A booking that has ended is not paid for here, whether or not its link could be withdrawn yet. Nor is a link that
  // the processor set up now did not make (one of test mode, left after the real keys went in): it cannot be paid.
  const ours = (deps.payments?.name ?? null) === row.link.provider;
  const status: PayPage["status"] = back
    ? "refunded"
    : ended && row.link.status !== "paid"
      ? "closed"
      : row.link.status === "open" && !ours
        ? "cancelled"
        : row.link.status;
  return {
    id: row.link.id,
    status,
    late: back ? { released, made: back.made } : null,
    closed: status === "closed" ? { released } : null,
    amountCents: row.link.amountCents,
    ref: row.booking.ref,
    studios: await studioNamesOf(db, row.booking.id),
    when: formatInstant(row.booking.startAt),
    processorUrl: status === "open" && row.link.provider !== "mock" ? row.link.url : null,
    pretend: row.link.provider === "mock" && ours,
  };
}

/**
 * Test mode only: the pretend processor "takes" the payment. With no card
 * processor connected nothing is charged, exactly as at checkout in test
 * mode. Refused for a link made by a real processor, and for any link once
 * the site is not in test mode (`configured`, the processor set up now): a
 * link of test mode left after the real keys went in records no money.
 */
export async function pretendToPay(db: Db, linkId: string, now: Date, configured: PaymentProvider | null): Promise<boolean> {
  if (configured?.name !== "mock" || !/^[0-9a-f-]{36}$/i.test(linkId)) return false;
  const [link] = await db.select().from(paymentLinks).where(eq(paymentLinks.id, linkId)).limit(1);
  if (!link || link.provider !== "mock" || link.status !== "open") return false;
  // A late payment's refund waits for the scheduled task here: there is no processor to send it in this call.
  return (await settle(db, link, { paymentId: `mock_link_${link.id}`, amountCents: link.amountCents }, now)).settled;
}
