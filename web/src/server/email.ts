import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { emailOutbox } from "@/db/schema";
import type { DbLike } from "@/db/client";

/**
 * Email is always queued in the database first, in the same step as the
 * change it reports, and delivered afterwards. A mail outage therefore never
 * blocks a booking, and nothing is lost: undelivered rows are retried.
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

export async function queueEmail(db: DbLike, message: QueuedEmail): Promise<void> {
  await db.insert(emailOutbox).values({
    toEmail: message.to.trim().toLowerCase(),
    replyTo: message.replyTo?.trim().toLowerCase() || null,
    subject: message.subject,
    body: message.body,
    kind: message.kind,
  });
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
    // Claim the row by bumping its attempt count; whoever loses the race skips it.
    const claimed = await db
      .update(emailOutbox)
      .set({ attempts: sql`${emailOutbox.attempts} + 1` })
      .where(and(eq(emailOutbox.id, row.id), isNull(emailOutbox.sentAt), eq(emailOutbox.attempts, row.attempts)))
      .returning({ id: emailOutbox.id });
    if (claimed.length === 0) continue;

    const result = await transport.send({
      to: row.toEmail,
      subject: row.subject,
      text: row.body,
      ...(row.replyTo ? { replyTo: row.replyTo } : {}),
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

const SIGN_OFF = "The Visuals Photo Studio\n7457 Aloma Ave, Suite 301, Winter Park, FL 32792";

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
      `Your sign-in code for The Visuals Photo Studio is ${code}.`,
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
  /** Part of the total covered by a reschedule credit. */
  creditCents: number;
  /** Part of the total charged to the card. */
  cardCents: number;
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
      "Your booking at The Visuals Photo Studio is confirmed.",
      "",
      `Reference: ${input.ref}`,
      `Studio: ${input.studios}`,
      `When: ${input.when} (${input.duration})`,
      `Total: ${money(input.totalCents)}`,
      ...(input.creditCents > 0
        ? [`Paid with your reschedule code: ${money(input.creditCents)}`, `Charged to your card: ${money(input.cardCents)}`]
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

export function cancellationEmail(input: {
  to: string;
  name: string;
  ref: string;
  when: string;
  refundCents: number;
  feeCents: number;
  /** Why no refund is due, when refundCents is 0. */
  note: string;
}): QueuedEmail {
  const refundLines =
    input.refundCents > 0
      ? [
          `A refund of ${money(input.refundCents)} is on its way to your card${
            input.feeCents > 0 ? ` (${money(input.feeCents)} processing fee kept)` : ""
          }. Banks usually show it within 5 to 10 business days.`,
        ]
      : [input.note];
  return {
    to: input.to,
    kind: "booking_cancelled",
    subject: `Booking cancelled: ${input.ref}`,
    body: [`Hi ${input.name},`, "", `Your booking ${input.ref} on ${input.when} has been cancelled.`, "", ...refundLines, "", SIGN_OFF].join("\n"),
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

export function loyaltyCodeEmail(input: {
  to: string;
  name: string;
  code: string;
  percent: number;
  expires: string;
  bookUrl: string;
}): QueuedEmail {
  return {
    to: input.to,
    kind: "loyalty_code",
    subject: `Thank you for visiting: ${input.percent}% off your next booking`,
    body: [
      `Hi ${input.name},`,
      "",
      `Thank you for shooting with us. Here is ${input.percent}% off your next studio rental.`,
      "",
      `Code: ${input.code}`,
      `Valid until: ${input.expires}`,
      "",
      `Book at ${input.bookUrl} and enter the code at checkout, with this email address. It works once.`,
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
          "The booking is cancelled and the customer was told a refund is coming. The system will retry; if it keeps failing, refund the payment in Square.",
        ].join("\n")
      : [
          `${input.automatic ? "An automatic refund" : "A refund"} of ${money(input.amountCents)} was sent for booking ${input.ref} (${input.customer}).`,
        ].join("\n"),
  };
}

/**
 * A charge whose outcome nobody knows: the processor never answered, or the
 * server stopped before the answer was recorded. The booking was not made,
 * but the card may have been charged.
 */
export function ownerPaymentUnknownNotice(input: {
  to: string;
  ref: string;
  customer: string;
  amountCents: number;
  /** True when the server stopped mid-charge; otherwise the processor gave no answer. */
  interrupted?: boolean;
}): QueuedEmail {
  return {
    to: input.to,
    kind: "owner_payment_unknown",
    subject: `ACTION NEEDED: check a payment for ${input.ref}`,
    body: [
      `A card payment of ${money(input.amountCents)} for booking ${input.ref} (${input.customer}) ${
        input.interrupted ? "was interrupted before its result was recorded." : "got no answer from Square."
      }`,
      "",
      "The booking was not made and its time was released. Square may still have charged the card.",
      `Look in Square for a payment with the reference ${input.ref}. If it is there, refund it.`,
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
