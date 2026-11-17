import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { emailOutbox } from "@/db/schema";
import type { DbLike } from "@/db/client";
import { afterFee } from "@/lib/domain/policy";
import { formatInstant } from "./tz";
import { loadBusiness } from "./website";

/**
 * Email is always queued in the database first, in the same step as the
 * change it reports, and delivered afterwards. A mail outage therefore never
 * blocks a booking, and nothing is lost: undelivered rows are retried.
 *
 * The studio's name and address are not written into the messages below.
 * Their texts carry two marks, `{{studio}}` and `{{address}}`, and
 * `queueEmail` puts the published contact details in their place (Admin,
 * Website, "Header, menu & footer"), so every email follows a change made
 * there.
 */
export interface QueuedEmail {
  to: string;
  subject: string;
  body: string;
  /** What the message is, e.g. "booking_confirmation". For filtering and tests. */
  kind: string;
  /** Who a reply should reach, when that is not the site's own address. */
  replyTo?: string;
}

/** Where `queueEmail` writes the studio's name, and its address on one line. */
const STUDIO = "{{studio}}";
const ADDRESS = "{{address}}";

/** The message with the studio's published name and address in place of their marks. */
async function filled(db: DbLike, message: QueuedEmail): Promise<{ subject: string; body: string }> {
  const business = await loadBusiness(db);
  const fill = (text: string) =>
    text.replaceAll(STUDIO, () => business.name).replaceAll(ADDRESS, () => `${business.addressLine1}, ${business.addressLine2}`);
  return { subject: fill(message.subject), body: fill(message.body) };
}

/** Queue a message. Answers its id, with which it can be replaced while it waits (`replaceQueuedEmail`). */
export async function queueEmail(db: DbLike, message: QueuedEmail): Promise<string> {
  const [row] = await db
    .insert(emailOutbox)
    .values({
      toEmail: message.to.trim().toLowerCase(),
      replyTo: message.replyTo?.trim().toLowerCase() || null,
      ...(await filled(db, message)),
      kind: message.kind,
    })
    .returning({ id: emailOutbox.id });
  return row.id;
}

/**
 * Put `message` in the place of a queued one that has not started on its way:
 * for a message written before the outcome it reports was known (a refund
 * that is sent after the cancellation is recorded). Answers false when the
 * queued one is already being sent, or was sent.
 */
export async function replaceQueuedEmail(db: DbLike, id: string, message: QueuedEmail): Promise<boolean> {
  const replaced = await db
    .update(emailOutbox)
    .set({ ...(await filled(db, message)), kind: message.kind })
    .where(and(eq(emailOutbox.id, id), isNull(emailOutbox.sentAt), eq(emailOutbox.attempts, 0)))
    .returning({ id: emailOutbox.id });
  return replaced.length > 0;
}

export type SendResult = { ok: true } | { ok: false; error: string };

export interface EmailTransport {
  name: string;
  send(message: { to: string; subject: string; text: string; replyTo?: string }): Promise<SendResult>;
}

/** Development transport: prints the message to the server log. */
export const logTransport: EmailTransport = {
  name: "log",
  async send(message) {
    const replyTo = message.replyTo ? ` (reply to ${message.replyTo})` : "";
    console.log(`\n── email to ${message.to}${replyTo} ──\n${message.subject}\n\n${message.text}\n──────────────\n`);
    return { ok: true };
  },
};

/** Delivery through Resend's HTTPS API (https://resend.com). */
export function resendTransport(config: { apiKey: string; from: string }): EmailTransport {
  return {
    name: "resend",
    async send(message) {
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: config.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            ...(message.replyTo ? { reply_to: message.replyTo } : {}),
          }),
        });
        if (response.ok) return { ok: true };
        const detail = await response.text().catch(() => "");
        return { ok: false, error: `HTTP ${response.status} ${detail.slice(0, 300)}` };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "network error" };
      }
    },
  };
}

type Env = Record<string, string | undefined>;

/**
 * Which transport delivers mail.
 *  - RESEND_API_KEY and EMAIL_FROM set -> Resend.
 *  - Otherwise outside production     -> the server log.
 *  - Otherwise (production)            -> none: mail stays queued until configured.
 */
export function resolveEmailTransport(env: Env = process.env): EmailTransport | null {
  if (env.RESEND_API_KEY && env.EMAIL_FROM) return resendTransport({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM });
  if (env.NODE_ENV !== "production") return logTransport;
  return null;
}

export const MAX_EMAIL_ATTEMPTS = 5;

/** Send queued messages, oldest first. Safe to run from several places at once. */
export async function deliverPendingEmails(
  db: DbLike,
  transport: EmailTransport | null,
  now: Date,
  limit = 25,
): Promise<{ sent: number; failed: number }> {
  if (!transport) return { sent: 0, failed: 0 };
  const pending = await db
    .select()
    .from(emailOutbox)
    .where(and(isNull(emailOutbox.sentAt), lt(emailOutbox.attempts, MAX_EMAIL_ATTEMPTS)))
    .orderBy(asc(emailOutbox.createdAt))
    .limit(limit);

  let sent = 0;
  let failed = 0;
  for (const row of pending) {
    // Claim the row by bumping its attempt count; whoever loses the race skips it. What is sent is the message as it is
    // once claimed: one put right meanwhile (`replaceQueuedEmail`) goes out put right.
    const [claimed] = await db
      .update(emailOutbox)
      .set({ attempts: sql`${emailOutbox.attempts} + 1` })
      .where(and(eq(emailOutbox.id, row.id), isNull(emailOutbox.sentAt), eq(emailOutbox.attempts, row.attempts)))
      .returning({ toEmail: emailOutbox.toEmail, subject: emailOutbox.subject, body: emailOutbox.body, replyTo: emailOutbox.replyTo });
    if (!claimed) continue;

    const result = await transport.send({
      to: claimed.toEmail,
      subject: claimed.subject,
      text: claimed.body,
      ...(claimed.replyTo ? { replyTo: claimed.replyTo } : {}),
    });
    if (result.ok) {
      await db.update(emailOutbox).set({ sentAt: now, error: null }).where(eq(emailOutbox.id, row.id));
      sent++;
    } else {
      await db.update(emailOutbox).set({ error: result.error }).where(eq(emailOutbox.id, row.id));
      failed++;
    }
  }
  return { sent, failed };
}

// ── Message texts ────────────────────────────────────────────────────────────

const SIGN_OFF = `${STUDIO}\n${ADDRESS}`;

function money(cents: number): string {
  const dollars = Math.floor(Math.abs(cents) / 100).toLocaleString("en-US");
  const rest = Math.abs(cents) % 100;
  return `${cents < 0 ? "-" : ""}$${dollars}${rest === 0 ? "" : `.${String(rest).padStart(2, "0")}`}`;
}

export function loginCodeEmail(to: string, code: string, minutes: number): QueuedEmail {
  return {
    to,
    kind: "login_code",
    subject: `Your sign-in code: ${code}`,
    body: [
      `Your sign-in code for ${STUDIO} is ${code}.`,
      "",
      `It works once and expires in ${minutes} minutes. If you did not ask for it, you can ignore this email.`,
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}

export function bookingConfirmationEmail(input: {
  to: string;
  name: string;
  ref: string;
  studios: string;
  when: string;
  duration: string;
  /** Price after discounts. */
  totalCents: number;
  /** Part of the total covered by an amount code: a reschedule code, or studio credit. */
  creditCents: number;
  /** What that code is called: "reschedule code" or "studio credit". */
  creditName?: string;
  /** Part of the total charged to the card. */
  cardCents: number;
  /** The studio made the booking for the client: nothing was charged, the total is paid at the studio. */
  payAtStudio?: boolean;
  /** A photography session: what it includes. */
  photoIncludes?: string;
  manageUrl: string;
  /** How to get into the building, when the owner has set it. */
  access?: string;
}): QueuedEmail {
  return {
    to: input.to,
    kind: "booking_confirmation",
    subject: `Booking confirmed: ${input.ref}`,
    body: [
      `Hi ${input.name},`,
      "",
      `Your booking at ${STUDIO} is confirmed.`,
      "",
      `Reference: ${input.ref}`,
      `Studio: ${input.studios}`,
      `When: ${input.when} (${input.duration})`,
      ...(input.photoIncludes !== undefined
        ? [
            `Photography session with our in-house photographer, studio included${input.photoIncludes ? `: ${input.photoIncludes}` : ""}.`,
            "Your edited images are delivered within 7 to 14 days.",
          ]
        : []),
      input.payAtStudio ? `To pay at the studio: ${money(input.totalCents)}` : `Total: ${money(input.totalCents)}`,
      ...(input.creditCents > 0
        ? [`Paid with your ${input.creditName ?? "reschedule code"}: ${money(input.creditCents)}`, `Charged to your card: ${money(input.cardCents)}`]
        : []),
      "",
      `View, cancel or move your booking: ${input.manageUrl}`,
      "",
      ...(input.access ? ["Getting in:", input.access, ""] : []),
      "Your booking begins at the scheduled start time. Please arrive no more than five minutes early.",
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}

/** An administrator moved the booking to a new time. The customer's link stays the same. */
export function bookingMovedEmail(input: {
  to: string;
  name: string;
  ref: string;
  studios: string;
  /** The old and the new time, as the studio's clock shows them. */
  was: string;
  now: string;
  duration: string;
  /** Set when the client asked for the move: it counts as their reschedule, which the rental terms do not refund. */
  clientAsked?: { canMoveAgain: boolean };
}): QueuedEmail {
  return {
    to: input.to,
    kind: "booking_moved",
    subject: `Your booking ${input.ref} has a new time`,
    body: [
      `Hi ${input.name},`,
      "",
      `Your booking at ${STUDIO} has been moved.`,
      "",
      `Reference: ${input.ref}`,
      `Studio: ${input.studios}`,
      `New time: ${input.now} (${input.duration})`,
      `It was: ${input.was}`,
      "",
      ...(input.clientAsked
        ? [
            `As you asked for this change, it counts as your reschedule under the rental terms: if the booking is cancelled now, it is not refunded${input.clientAsked.canMoveAgain ? "" : ", and it cannot be moved again online"}.`,
            "",
          ]
        : []),
      "The link in your confirmation email still opens this booking. If the new time does not suit you, please reply to this email or call us.",
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}

/**
 * Where a card refund stands: `sent` when the processor accepted it, `not_yet`
 * when it did not go through, and is tried again.
 */
export type RefundState = "sent" | "not_yet";

/** A card refund, in a sentence: what the customer can expect. */
function refundSentence(refund: { cents: number; feeCents: number; state: RefundState }): string {
  const fee = refund.feeCents > 0 ? ` (${money(refund.feeCents)} processing fee kept)` : "";
  return refund.state === "sent"
    ? `A refund of ${money(refund.cents)} is on its way to your card${fee}. Banks usually show it within 5 to 10 business days.`
    : `A refund of ${money(refund.cents)} is due to your card${fee}, and has not reached it yet: it is tried again by itself, and the studio has been told.`;
}

export function cancellationEmail(input: {
  to: string;
  name: string;
  ref: string;
  when: string;
  /** True when the studio cancelled: the email says so first. */
  byStudio?: boolean;
  /** The card refund, when there is one. */
  refund?: { cents: number; feeCents: number; state: RefundState };
  /** The rest of what the cancellation does, or why nothing is refunded: a sentence each. */
  lines: string[];
  /**
   * The pet fee, returned as a code for studio credit and not to the card:
   * `cents` of a fee of `feeCents`. `card` is false for a booking that no
   * card paid, which is not told about a card.
   */
  petCredit?: { code: string; cents: number; feeCents: number; card?: boolean; expires: string; bookUrl: string };
}): QueuedEmail {
  const credit = input.petCredit;
  const notBack = credit?.card === false ? "not refunded" : "not refunded to a card";
  const creditLines = credit
    ? [
        "",
        credit.cents === credit.feeCents
          ? `The pet fee of ${money(credit.feeCents)} is ${notBack}. It is returned to you as studio credit:`
          : `Of the pet fee, ${money(credit.cents)} is returned to you as studio credit, ${credit.card === false ? "not refunded" : "not to a card"}:`,
        "",
        `Code: ${credit.code}`,
        `Valid until: ${credit.expires}`,
        "",
        `Book at ${credit.bookUrl} and enter the code at checkout, with this email address. What you do not spend stays on the code.`,
      ]
    : [];
  const outcome = [...(input.refund ? [refundSentence(input.refund)] : []), ...input.lines];
  return {
    to: input.to,
    kind: "booking_cancelled",
    subject: `Booking cancelled: ${input.ref}`,
    body: [
      `Hi ${input.name},`,
      "",
      `Your booking ${input.ref} on ${input.when} has been cancelled${input.byStudio ? " by the studio" : ""}.`,
      // One empty line between parts, also when the cancellation says nothing but the pet fee's credit.
      ...(outcome.length > 0 ? ["", ...outcome] : []),
      ...creditLines,
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}

/**
 * A card refund that was promised in a cancellation email already on its way
 * did not go through: what the customer was told is put right.
 */
export function refundNotYetEmail(input: { to: string; name: string; ref: string; cents: number; feeCents: number }): QueuedEmail {
  return {
    to: input.to,
    kind: "refund_not_yet",
    subject: `Your refund for booking ${input.ref}`,
    body: [
      `Hi ${input.name},`,
      "",
      `About your cancelled booking ${input.ref}: ${refundSentence({ cents: input.cents, feeCents: input.feeCents, state: "not_yet" })}`,
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}

/** The pet did not come: the pet fee of a booking is returned as studio credit. */
export function petCreditEmail(input: {
  to: string;
  name: string;
  ref: string;
  code: string;
  cents: number;
  expires: string;
  bookUrl: string;
}): QueuedEmail {
  return {
    to: input.to,
    kind: "pet_credit",
    subject: `Your pet fee for booking ${input.ref} is now studio credit`,
    body: [
      `Hi ${input.name},`,
      "",
      `Your pet did not come to booking ${input.ref}, so the pet fee of ${money(input.cents)} is returned to you as studio credit.`,
      "",
      `Code: ${input.code}`,
      `Valid until: ${input.expires}`,
      "",
      `Book at ${input.bookUrl} and enter the code at checkout, with this email address. What you do not spend stays on the code.`,
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}

/** A payment taken at the studio was recorded for a booking: the customer's confirmation of it. */
export function paymentReceivedEmail(input: {
  to: string;
  name: string;
  ref: string;
  when: string;
  amountCents: number;
  /** How it was paid, in words: "Cash". */
  method: string;
  /** What is still to pay after this payment. */
  dueCents: number;
  /** True when it was paid by card through a payment link, not at the studio. */
  online?: boolean;
}): QueuedEmail {
  return {
    to: input.to,
    kind: "payment_received",
    subject: `Payment received for booking ${input.ref}`,
    body: [
      `Hi ${input.name},`,
      "",
      `We received your payment of ${money(input.amountCents)} for booking ${input.ref} on ${input.when}.`,
      "",
      input.online ? `Paid by: ${input.method}` : `Paid at the studio: ${input.method}`,
      input.dueCents > 0 ? `Still to pay: ${money(input.dueCents)}` : "Your booking is paid in full.",
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}

/** A refund of a booking released for a reschedule code: it came off the code, and the client is told what is left on it. */
/**
 * A refund of a booking released for a reschedule code, which came off that
 * code. What is left on it is named only while the code can be spent. A
 * card refund's `state` says whether it went through, as a cancellation's
 * email does.
 */
export function codeRefundEmail(input: {
  to: string;
  name: string;
  ref: string;
  code: string;
  cents: number;
  leftCents: number;
  /** False once the code was cancelled or has expired. */
  usable: boolean;
  byHand: boolean;
  state?: RefundState;
}): QueuedEmail {
  const what = input.byHand ? `${money(input.cents)} given back to you at the studio` : `A refund of ${money(input.cents)} to your card`;
  const left =
    input.leftCents <= 0
      ? ", which has nothing left on it."
      : input.usable
        ? `, which now has ${money(input.leftCents)} left.`
        : ". That code can no longer be used.";
  const notYet = !input.byHand && input.state === "not_yet" ? " The refund has not reached your card yet: it is tried again by itself, and the studio has been told." : "";
  return {
    to: input.to,
    kind: "reschedule_code_refund",
    subject: `A refund for booking ${input.ref}`,
    body: [`Hi ${input.name},`, "", `${what} for booking ${input.ref} came off your reschedule code ${input.code}${left}${notYet}`, "", SIGN_OFF].join("\n"),
  };
}

/**
 * A payment through a link that reached the site after its booking was
 * cancelled, or released for a reschedule code: it is given back in full.
 * `state` says whether the refund went through, as a cancellation's email does.
 */
export function latePaymentEmail(input: { to: string; name: string; ref: string; amountCents: number; released: boolean; state: RefundState }): QueuedEmail {
  const ended = input.released ? "was released for a reschedule code" : "was cancelled";
  const back =
    input.state === "sent"
      ? "so it is refunded to your card in full. Banks usually show a refund within 5 to 10 business days."
      : "so it is due back to your card in full. It has not reached your card yet: it is tried again by itself, and the studio has been told.";
  return {
    to: input.to,
    kind: "late_payment_refunded",
    subject: input.state === "sent" ? `Your payment for booking ${input.ref} is refunded` : `Your payment for booking ${input.ref} is due back to your card`,
    body: [`Hi ${input.name},`, "", `Your payment of ${money(input.amountCents)} for booking ${input.ref} reached us after the booking ${ended}, ${back}`, "", SIGN_OFF].join("\n"),
  };
}

/** The link an administrator sends so that a client can pay by card what their booking still owes. */
export function payLinkEmail(input: {
  to: string;
  name: string;
  ref: string;
  when: string;
  amountCents: number;
  /** The page on this site that leads to the processor's payment page. */
  payUrl: string;
}): QueuedEmail {
  return {
    to: input.to,
    kind: "payment_link",
    subject: `Pay for your booking ${input.ref}`,
    body: [
      `Hi ${input.name},`,
      "",
      `You can pay for your booking ${input.ref} on ${input.when} by card here:`,
      "",
      input.payUrl,
      "",
      `Amount: ${money(input.amountCents)}`,
      "",
      "The card payment page is run by Square, our card processor: your card details never reach us. If you would rather pay at the studio, you still can.",
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}

/**
 * A booking paid at the studio was cancelled early enough to be refunded. The
 * site cannot send that money back, so the owner is asked to.
 */
export function ownerHandRefundNotice(input: { to: string; ref: string; customer: string; paidCents: number; feePercent: number }): QueuedEmail {
  return {
    to: input.to,
    kind: "owner_hand_refund",
    subject: `ACTION NEEDED: refund by hand for ${input.ref}`,
    body: [
      `${input.customer} cancelled booking ${input.ref} early enough to be refunded.`,
      "",
      `Of what was paid at the studio, ${money(input.paidCents)} is refunded by the rental terms${
        input.feePercent > 0 ? `, less the ${input.feePercent}% fee: ${money(afterFee(input.paidCents, input.feePercent))}` : ", in full"
      }. The site cannot send that back.`,
      "Refund the customer by hand, then record the refund on the appointment's page.",
    ].join("\n"),
  };
}

export function rescheduleCodeEmail(input: {
  to: string;
  name: string;
  ref: string;
  code: string;
  valueCents: number;
  /** The part of the value that is a discount the customer's code gave, not money paid. */
  discountCents?: number;
  expires: string;
  bookUrl: string;
}): QueuedEmail {
  const credit =
    (input.discountCents ?? 0) > 0
      ? `Your booking ${input.ref} has been released. What you paid, plus the ${money(input.discountCents!)} your discount code took off, is now a credit of ${money(input.valueCents)}.`
      : `Your booking ${input.ref} has been released, and what you paid is now a credit of ${money(input.valueCents)}.`;
  return {
    to: input.to,
    kind: "reschedule_code",
    subject: `Your reschedule code for booking ${input.ref}`,
    body: [
      `Hi ${input.name},`,
      "",
      credit,
      "",
      `Reschedule code: ${input.code}`,
      `Valid until: ${input.expires}`,
      "",
      `Book your new time at ${input.bookUrl} and enter the code at checkout, with this email address. If the new booking costs more, you pay only the difference. If it costs less, the rest stays on the code.`,
      "",
      "A booking made with a reschedule code cannot be refunded.",
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}

/** The loyalty reward: one free hour, earned by visiting on `visits` separate days. */
export function freeHourEmail(input: {
  to: string;
  name: string;
  code: string;
  /** How many visits earned it. */
  visits: number;
  expires: string;
  bookUrl: string;
}): QueuedEmail {
  return {
    to: input.to,
    kind: "loyalty_code",
    subject: "You have earned a free hour in the studio",
    body: [
      `Hi ${input.name},`,
      "",
      `Thank you for shooting with us ${input.visits} times. Your next hour is on us.`,
      "",
      `Code: ${input.code}`,
      `Valid until: ${input.expires}`,
      "",
      `Book any one studio at ${input.bookUrl} and enter the code at checkout, with this email address. It works once.`,
      "",
      "The price of one hour comes off your booking: a one-hour booking is free, and a longer one costs the rest. The free hour is for one studio, so it cannot be used when several studios are booked together, and it does not pay for add-ons.",
      "",
      `Every ${input.visits} visits, on separate days, earn another free hour. A visit made with a free hour does not count, and neither does a photography session with our photographer.`,
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}

export function ownerRefundNotice(input: {
  to: string;
  ref: string;
  customer: string;
  amountCents: number;
  automatic: boolean;
  failedReason?: string;
  /** What the refund is for, as recorded with it. */
  reason?: string;
}): QueuedEmail {
  const failed = input.failedReason !== undefined;
  return {
    to: input.to,
    kind: failed ? "owner_refund_failed" : "owner_refund_notice",
    subject: failed
      ? `ACTION NEEDED: refund failed for ${input.ref}`
      : `Refund ${money(input.amountCents)} for ${input.ref}`,
    body: failed
      ? [
          `A refund of ${money(input.amountCents)} for booking ${input.ref} (${input.customer}) could not be sent.`,
          "",
          `Reason: ${input.failedReason}`,
          "",
          "The site tries it again by itself. If it keeps failing, refund the payment in Square, then press \u201cRefunded it in Square\u201d beside it on the admin's overview, so that the site stops trying.",
        ].join("\n")
      : [
          `${input.automatic ? "An automatic refund" : "A refund"} of ${money(input.amountCents)} was sent for booking ${input.ref} (${input.customer})${
            input.reason ? `: ${input.reason.replace(/[.!?]$/, "")}` : ""
          }.`,
        ].join("\n"),
  };
}

/**
 * A charge whose outcome nobody knows: the processor never answered, or the
 * server stopped before the answer was recorded. The booking was not made,
 * but the card may have been charged.
 */
/**
 * A booking whose card amount was reserved, and whose money could not be
 * taken yet (src/server/reserved.ts). The booking stands; the site keeps
 * trying; past `givenBackAt` the processor gives the amount back by itself.
 */
export function ownerCaptureNotice(input: {
  to: string;
  ref: string;
  customer: string;
  amountCents: number;
  reason: string;
  givenBackAt: Date;
}): QueuedEmail {
  return {
    to: input.to,
    kind: "owner_capture_failed",
    subject: `Payment not taken yet for ${input.ref}`,
    body: [
      `The card for booking ${input.ref} (${input.customer}) has ${money(input.amountCents)} reserved on it, and the booking is confirmed, but taking the money did not go through.`,
      "",
      `Reason: ${input.reason}`,
      "",
      `The site tries again every time its scheduled task runs. If the money has not been taken by ${formatInstant(input.givenBackAt)}, Square gives the amount back to the card and the booking is unpaid: then take the payment at the studio, or cancel the booking.`,
    ].join("\n"),
  };
}

/** A visitor's message from the contact page, sent to the owner. Replying reaches the visitor. */
export function contactMessageEmail(input: {
  to: string;
  name: string;
  email: string;
  topic: string;
  message: string;
}): QueuedEmail {
  return {
    to: input.to,
    replyTo: input.email,
    kind: "contact_message",
    subject: `Website message from ${input.name}: ${input.topic}`,
    body: [
      `${input.name} <${input.email}> wrote through the contact page.`,
      `Topic: ${input.topic}`,
      "",
      input.message,
      "",
      `Reply to this email to answer ${input.name}.`,
    ].join("\n"),
  };
}
