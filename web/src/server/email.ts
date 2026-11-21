import { and, asc, eq, isNull, lt, lte, sql } from "drizzle-orm";
import { emailOutbox } from "@/db/schema";
import type { DbLike } from "@/db/client";
import { afterFee } from "@/lib/domain/policy";
import { durationLabel, longDateLabel } from "@/lib/domain/time";
import { EMAIL_TEMPLATES, firstNameOf, renderEmail, type TemplateKey } from "@/lib/email-templates";
import { mayUseTestTools } from "./browser-test-server";
import { ownersWording } from "./email-templates";
import { formatInstant } from "./tz";
import { loadBusiness } from "./website";

/**
 * Email is always queued in the database first, in the same step as the
 * change it reports, and delivered afterwards. A mail outage therefore never
 * blocks a booking, and nothing is lost: undelivered rows are retried.
 *
 * The studio's name and address are not written into the messages below.
 * Their texts carry two marks, `{{studio_name}}` and `{{studio_address}}`, and
 * `queueEmail` puts the published contact details in their place (Admin,
 * Website, "Header, menu & footer"), so every email follows a change made
 * there.
 *
 * A message to a client is written from its template (`src/lib/email-templates.ts`):
 * in the site's wording here, and in the owners' when they have changed that
 * email under Admin → Emails, which `queueEmail` puts in its place.
 */
export interface QueuedEmail {
  to: string;
  subject: string;
  body: string;
  /** What the message is, e.g. "booking_confirmation". For filtering and tests. */
  kind: string;
  /** Who a reply should reach, when that is not the site's own address. */
  replyTo?: string;
  /** When the message is no longer any use (a sign-in code's email): one still waiting then is not sent. */
  expiresAt?: Date;
  /** The template a message is written from, with the parts the site filled in. */
  template?: { key: TemplateKey; parts: Readonly<Record<string, string>> };
}

/** Where `queueEmail` writes the studio's name, and its address on one line: the template parts of those names. */
const STUDIO = "{{studio_name}}";
const ADDRESS = "{{studio_address}}";

/**
 * The message as it is sent: in the owners' wording when they have changed its email, with the studio's published
 * name and address in place of their marks. Wording that would leave the subject or the text empty is not used.
 */
async function composed(db: DbLike, message: QueuedEmail): Promise<{ subject: string; body: string }> {
  const own = message.template ? await ownersWording(db, message.template.key) : null;
  const theirs = own && message.template ? renderEmail(own, message.template.parts) : null;
  const text = theirs && theirs.subject !== "" && theirs.body !== "" ? theirs : message;
  const business = await loadBusiness(db);
  const fill = (part: string) =>
    part.replaceAll(STUDIO, () => business.name).replaceAll(ADDRESS, () => `${business.addressLine1}, ${business.addressLine2}`);
  return { subject: fill(text.subject), body: fill(text.body) };
}

/** Queue a message. Answers its id, with which it can be replaced while it waits (`replaceQueuedEmail`). */
export async function queueEmail(db: DbLike, message: QueuedEmail): Promise<string> {
  const [row] = await db
    .insert(emailOutbox)
    .values({
      toEmail: message.to.trim().toLowerCase(),
      replyTo: message.replyTo?.trim().toLowerCase() || null,
      ...(await composed(db, message)),
      kind: message.kind,
      expiresAt: message.expiresAt ?? null,
    })
    .returning({ id: emailOutbox.id });
  return row.id;
}

/**
 * A message written from its template with these parts, to a client or to the studio: in the site's wording, which
 * `queueEmail` replaces with the owners' when they have changed the email. `first_name` comes with `name`.
 */
function written(key: TemplateKey, head: { to: string; kind: string; replyTo?: string }, parts: Record<string, string>): QueuedEmail {
  const all = Object.hasOwn(parts, "name") ? { ...parts, first_name: firstNameOf(parts.name) } : parts;
  return { ...head, ...renderEmail(EMAIL_TEMPLATES[key], all), template: { key, parts: all } };
}

export function reviewRequestEmail(input: { email: string; name: string; ref: string }): QueuedEmail {
  return written("review_request", { to: input.email, kind: "review_request" }, { name: input.name, reference: input.ref });
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
    .set({ ...(await composed(db, message)), kind: message.kind })
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
const logTransport: EmailTransport = {
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
 *  - Otherwise outside production     -> the server log. So too on the browser tests' own production server
 *                                        (`mayUseTestTools`).
 *  - Otherwise (production)            -> none: mail stays queued until configured.
 */
export function resolveEmailTransport(env: Env = process.env): EmailTransport | null {
  if (env.RESEND_API_KEY && env.EMAIL_FROM) return resendTransport({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM });
  if (mayUseTestTools(env)) return logTransport;
  return null;
}

export const MAX_EMAIL_ATTEMPTS = 5;

/** Why a message that waited past its use is not sent: what a person reading the outbox sees. */
export const OUT_OF_DATE = "Not sent: it was out of date before it could be sent.";

/**
 * Send queued messages, oldest first. Safe to run from several places at once.
 * One that is no longer any use (a sign-in code whose minutes are over, when
 * no email service was set up yet) is not sent: it is marked out of date.
 */
export async function deliverPendingEmails(
  db: DbLike,
  transport: EmailTransport | null,
  now: Date,
  limit = 25,
): Promise<{ sent: number; failed: number }> {
  if (!transport) return { sent: 0, failed: 0 };
  await db
    .update(emailOutbox)
    .set({ attempts: MAX_EMAIL_ATTEMPTS, error: OUT_OF_DATE })
    .where(and(isNull(emailOutbox.sentAt), lt(emailOutbox.attempts, MAX_EMAIL_ATTEMPTS), lte(emailOutbox.expiresAt, now)));
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

function money(cents: number): string {
  const dollars = Math.floor(Math.abs(cents) / 100).toLocaleString("en-US");
  const rest = Math.abs(cents) % 100;
  return `${cents < 0 ? "-" : ""}$${dollars}${rest === 0 ? "" : `.${String(rest).padStart(2, "0")}`}`;
}

/** How to get into the building, under its heading: the part `getting_in`, empty when the owners have set nothing. */
const gettingIn = (access: string | undefined) => (access ? `Getting in:\n${access}` : "");

/** A photography session in a sentence, with what it includes when that is set. */
const sessionSentence = (includes: string) => `Photography session with our in-house photographer, studio included${includes ? `: ${includes}` : ""}.`;

export function loginCodeEmail(to: string, code: string, minutes: number): QueuedEmail {
  return written("login_code", { to, kind: "login_code" }, { code, minutes: String(minutes) });
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
  // Part paid with a code or membership hours: the whole, that part, and the rest, paid by card or, for a booking the
  // studio made, at the studio.
  // Nothing left after the code or the hours: no line says a card was charged, or that anything is to pay (the tester's
  // finding of 2026-11-18: "Charged to your card: $0" for a booking the studio made).
  const payment =
    input.creditCents > 0
      ? [
          `Total: ${money(input.totalCents)}`,
          `Paid with your ${input.creditName ?? "reschedule code"}: ${money(input.creditCents)}`,
          ...(input.cardCents > 0 ? [input.payAtStudio ? `To pay at the studio: ${money(input.cardCents)}` : `Charged to your card: ${money(input.cardCents)}`] : []),
        ]
      : [input.payAtStudio && input.totalCents > 0 ? `To pay at the studio: ${money(input.totalCents)}` : `Total: ${money(input.totalCents)}`];
  return written(
    "booking_confirmation",
    { to: input.to, kind: "booking_confirmation" },
    {
      name: input.name,
      reference: input.ref,
      studios: input.studios,
      when: input.when,
      duration: input.duration,
      photography: input.photoIncludes !== undefined ? `${sessionSentence(input.photoIncludes)}\nYour edited images are delivered within 7 to 14 days.` : "",
      payment: payment.join("\n"),
      booking_link: input.manageUrl,
      getting_in: gettingIn(input.access),
    },
  );
}

/**
 * A client asked the studio to move their booking (question 20 of 2026-11-17): to the studio, with what the client
 * wrote and a reply that reaches the client.
 */
export function moveRequestStudioEmail(input: {
  to: string;
  client: { name: string; email: string; phone: string };
  ref: string;
  studios: string;
  when: string;
  duration: string;
  message: string;
  appointmentUrl: string;
}): QueuedEmail {
  return written(
    "move_request_studio",
    { to: input.to, kind: "move_request_studio", replyTo: input.client.email },
    {
      client_name: input.client.name,
      reference: input.ref,
      studios: input.studios,
      when: input.when,
      duration: input.duration,
      client: `${input.client.name}, ${input.client.email}${input.client.phone ? `, ${input.client.phone}` : ""}`,
      message: input.message,
      appointment_link: input.appointmentUrl,
    },
  );
}

/** The client's copy of their request to move a booking. */
export function moveRequestReceivedEmail(input: { to: string; name: string; ref: string; when: string; message: string }): QueuedEmail {
  return written(
    "move_request_received",
    { to: input.to, kind: "move_request_received" },
    { name: input.name, reference: input.ref, when: input.when, message: input.message },
  );
}

/** The reminder before a visit (`queueReminders` in tasks.ts), with how to get in as it is now. */
export function bookingReminderEmail(input: {
  to: string;
  name: string;
  ref: string;
  studios: string;
  when: string;
  duration: string;
  /** A photography session: what it includes. */
  photoIncludes?: string;
  /** What is still to pay, if anything; `atStudio` for a booking the studio made, which is paid there. */
  dueCents: number;
  atStudio: boolean;
  /** How to get into the building, when the owner has set it. */
  access?: string;
}): QueuedEmail {
  return written(
    "booking_reminder",
    { to: input.to, kind: "booking_reminder" },
    {
      name: input.name,
      reference: input.ref,
      studios: input.studios,
      when: input.when,
      duration: input.duration,
      photography: input.photoIncludes !== undefined ? sessionSentence(input.photoIncludes) : "",
      to_pay: input.dueCents > 0 ? `${input.atStudio ? "To pay at the studio" : "Still to pay"}: ${money(input.dueCents)}` : "",
      getting_in: gettingIn(input.access),
    },
  );
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
  /**
   * Set when the client asked for the move: it counts as their reschedule, which the rental terms do not refund.
   * `againFeeCents`: what moving it again online costs, 0 when the next move is free.
   */
  clientAsked?: { canMoveAgain: boolean; againFeeCents?: number };
  /**
   * Set when the new day priced the booking differently (follow-up 5, `movePriceText` in reprice.ts): its new total, and
   * what is still to pay, what comes back to the client, or what went back on their code.
   */
  priceNote?: string;
}): QueuedEmail {
  const asked = input.clientAsked;
  const again = !asked
    ? ""
    : !asked.canMoveAgain
      ? ", and it cannot be moved again online."
      : (asked.againFeeCents ?? 0) > 0
        ? `. Moving it again online costs ${money(asked.againFeeCents!)}.`
        : ".";
  return written(
    "booking_moved",
    { to: input.to, kind: "booking_moved" },
    {
      name: input.name,
      reference: input.ref,
      studios: input.studios,
      when: input.now,
      duration: input.duration,
      old_time: input.was,
      reschedule_note: asked
        ? `As you asked for this change, it counts as a reschedule under the rental terms: if the booking is cancelled now, it is not refunded${again}`
        : "",
      price_note: input.priceNote ?? "",
    },
  );
}

/**
 * Where a card refund stands: `sent` when the processor accepted it, `not_yet`
 * when it has not gone through: it failed, and is tried again, or it waits for
 * the card processor its payment was taken through. Either way the studio was
 * told, and the client is told no more than that.
 */
export type RefundState = "sent" | "not_yet";

/** What a client reads of a card refund that has not reached their card: true whatever keeps it back. */
const REFUND_NOT_YET = "the studio has been told, and will see that it does.";

/** A card refund, in a sentence: what the customer can expect. */
function refundSentence(refund: { cents: number; feeCents: number; state: RefundState }): string {
  const fee = refund.feeCents > 0 ? ` (${money(refund.feeCents)} processing fee kept)` : "";
  return refund.state === "sent"
    ? `A refund of ${money(refund.cents)} is on its way to your card${fee}. Banks usually show it within 5 to 10 business days.`
    : `A refund of ${money(refund.cents)} is due to your card${fee}, and has not reached it yet: ${REFUND_NOT_YET}`;
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
  const petCredit = credit
    ? [
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
  return written(
    input.byStudio ? "booking_cancelled_by_studio" : "booking_cancelled",
    { to: input.to, kind: "booking_cancelled" },
    { name: input.name, reference: input.ref, when: input.when, outcome: outcome.join("\n"), pet_credit: petCredit.join("\n") },
  );
}

/**
 * A card refund that was promised in a cancellation email already on its way
 * did not go through: what the customer was told is put right.
 */
export function refundNotYetEmail(input: { to: string; name: string; ref: string; cents: number; feeCents: number }): QueuedEmail {
  return written(
    "refund_not_yet",
    { to: input.to, kind: "refund_not_yet" },
    { name: input.name, reference: input.ref, refund: refundSentence({ cents: input.cents, feeCents: input.feeCents, state: "not_yet" }) },
  );
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
  return written(
    "pet_credit",
    { to: input.to, kind: "pet_credit" },
    { name: input.name, reference: input.ref, amount: money(input.cents), code: input.code, valid_until: input.expires, book_link: input.bookUrl },
  );
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
  return written(
    "payment_received",
    { to: input.to, kind: "payment_received" },
    {
      name: input.name,
      reference: input.ref,
      when: input.when,
      amount: money(input.amountCents),
      paid_how: input.online ? `Paid by: ${input.method}` : `Paid at the studio: ${input.method}`,
      balance: input.dueCents > 0 ? `Still to pay: ${money(input.dueCents)}` : "Your booking is paid in full.",
    },
  );
}

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
  const notYet = !input.byHand && input.state === "not_yet" ? ` The refund has not reached your card yet: ${REFUND_NOT_YET}` : "";
  return written(
    "reschedule_code_refund",
    { to: input.to, kind: "reschedule_code_refund" },
    { name: input.name, reference: input.ref, code: input.code, refund: `${what} for booking ${input.ref} came off your reschedule code ${input.code}${left}${notYet}` },
  );
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
      : `so it is due back to your card in full. It has not reached your card yet: ${REFUND_NOT_YET}`;
  return written(
    input.state === "sent" ? "late_payment_refunded" : "late_payment_due",
    { to: input.to, kind: "late_payment_refunded" },
    {
      name: input.name,
      reference: input.ref,
      amount: money(input.amountCents),
      // "Recorded": a payment the processor could not tell the site about at the time may have been made before.
      refund: `Your payment of ${money(input.amountCents)} through the payment link for booking ${input.ref} was recorded after the booking ${ended}, ${back}`,
    },
  );
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
  /** The extra charges the booking has (follow-up 13), as the client reads them: each with what it is for. */
  charges?: { label: string; cents: number }[];
}): QueuedEmail {
  const charges = input.charges ?? [];
  return written(
    "payment_link",
    { to: input.to, kind: "payment_link" },
    {
      name: input.name,
      reference: input.ref,
      when: input.when,
      pay_link: input.payUrl,
      amount: money(input.amountCents),
      charges: charges.length > 0 ? ["It includes the extra charges of your visit:", ...charges.map((charge) => `${charge.label}, ${money(charge.cents)}`)].join("\n") : "",
    },
  );
}

/**
 * A booking paid at the studio, or through Acuity before this website (`place`, `handPaidPlaceOf`), was cancelled
 * early enough to be refunded. The site cannot send that money back, so the owner is asked to.
 */
export function ownerHandRefundNotice(input: { to: string; ref: string; customer: string; paidCents: number; feePercent: number; place?: string }): QueuedEmail {
  return written(
    "owner_hand_refund",
    { to: input.to, kind: "owner_hand_refund" },
    {
      customer: input.customer,
      reference: input.ref,
      refund: `Of what was paid ${input.place ?? "at the studio"}, ${money(input.paidCents)} is refunded by the rental terms${
        input.feePercent > 0 ? `, less the ${input.feePercent}% fee: ${money(afterFee(input.paidCents, input.feePercent))}` : ", in full"
      }. The site cannot send that back.`,
    },
  );
}

/**
 * A booking ended while the card processor could not say whether its payment
 * link had been paid. The client is told the same (`UNSEEN_LINK`).
 */
export const UNSEEN_LINK =
  "We could not check just now whether the payment link for this booking was paid. If it was, that payment is refunded to your card in full once the card processor tells us.";

/** The same, for a link of another processor than the one set up now, which the site can never ask. */
export const FOREIGN_LINK = "The site cannot check the payment link for this booking. If you paid it, please contact us, and we will refund it.";

export function ownerUnseenLinkNotice(input: {
  to: string;
  ref: string;
  customer: string;
  linkCents: number;
  ended: "cancelled" | "released";
  /**
   * `unseen`: the processor could not say. `other`: the link was made by another processor than the one set up now (in
   * test mode, or with Square's other account), which the site can never ask. `none`: no processor was set up.
   */
  kind: "unseen" | "other" | "none";
}): QueuedEmail {
  const ended = `${input.customer}'s booking ${input.ref} was ${input.ended === "released" ? "released for a reschedule code" : "cancelled"}`;
  const close = 'close it on the appointment\'s page with "Close it by hand"';
  const settle = `When it was not paid, ${close}. When it was paid, refund it to the client there, as the client was told to ask, then ${close}.`;
  const whatHappened =
      input.kind === "other"
        ? [
            `${ended}. Its payment link for ${money(input.linkCents)} was made by another card processor than the one set up now (in test mode, or with Square's other account), which the site cannot ask whether it was paid.`,
            "",
            `Look the link up there. ${settle}`,
          ].join("\n")
        : input.kind === "none"
          ? [
              `${ended} while no card processor was set up, so the site could not ask whether its payment link for ${money(input.linkCents)} had been paid.`,
              "",
              `Look the link up in Square. ${settle}`,
            ].join("\n")
          : [
              `${ended} while the card processor could not say whether its payment link for ${money(input.linkCents)} had been paid.`,
              "",
              "If it was paid, the payment is refunded to the card in full once the processor tells the site, and the client was told so. The site keeps asking.",
              `If the processor never can (a link it no longer knows), look the link up in Square. When it was not paid, ${close}. When Square shows it was paid, the site will never see that payment: refund it to the client in Square, as they were promised, then ${close}.`,
            ].join("\n");
  return written(
    "owner_unseen_link",
    { to: input.to, kind: "owner_unseen_link" },
    { reference: input.ref, customer: input.customer, what_happened: whatHappened },
  );
}

export function rescheduleCodeEmail(input: {
  to: string;
  name: string;
  ref: string;
  code: string;
  valueCents: number;
  /** The part of the value that is a discount the customer's code gave, not money paid. */
  discountCents?: number;
  /** The fee for a move after the free ones, already taken off the value. */
  feeCents?: number;
  expires: string;
  bookUrl: string;
  /** What the client is told of a payment link the site could not check (`UNSEEN_LINK`, `FOREIGN_LINK`). */
  unseenNote?: string | null;
}): QueuedEmail {
  const fee = (input.feeCents ?? 0) > 0 ? `less the ${money(input.feeCents!)} fee for moving a booking again` : "";
  const credit =
    (input.discountCents ?? 0) > 0
      ? `Your booking ${input.ref} has been released. What you paid, plus the ${money(input.discountCents!)} your discount code took off${fee ? `, ${fee}` : ""}, is now a credit of ${money(input.valueCents)}.`
      : fee
        ? `Your booking ${input.ref} has been released. What you paid, ${fee}, is now a credit of ${money(input.valueCents)}.`
        : `Your booking ${input.ref} has been released, and what you paid is now a credit of ${money(input.valueCents)}.`;
  return written(
    "reschedule_code",
    { to: input.to, kind: "reschedule_code" },
    {
      name: input.name,
      reference: input.ref,
      credit,
      value: money(input.valueCents),
      link_note: input.unseenNote ?? "",
      code: input.code,
      valid_until: input.expires,
      book_link: input.bookUrl,
    },
  );
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
  return written(
    "loyalty_code",
    { to: input.to, kind: "loyalty_code" },
    { name: input.name, visits: String(input.visits), code: input.code, valid_until: input.expires, book_link: input.bookUrl },
  );
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
  const head = { to: input.to, kind: failed ? "owner_refund_failed" : "owner_refund_notice" };
  const parts = { amount: money(input.amountCents), reference: input.ref, customer: input.customer };
  return failed
    ? written("owner_refund_failed", head, { ...parts, reason: input.failedReason ?? "" })
    : written("owner_refund_sent", head, {
        ...parts,
        refund: `${input.automatic ? "An automatic refund" : "A refund"} of ${money(input.amountCents)} was sent for booking ${input.ref} (${input.customer})${
          input.reason ? `: ${input.reason.replace(/[.!?]$/, "")}` : ""
        }.`,
      });
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
  return written("owner_capture_failed", { to: input.to, kind: "owner_capture_failed" }, {
    amount: money(input.amountCents),
    reference: input.ref,
    customer: input.customer,
    reason: input.reason,
    given_back: formatInstant(input.givenBackAt),
  });
}

/** A refund that cannot be sent with the card processor set up now, and waits for the right one. */
export function ownerRefundWaitingNotice(input: { to: string; ref: string; customer: string; amountCents: number; reason: string }): QueuedEmail {
  return written("owner_refund_waiting", { to: input.to, kind: "owner_refund_waiting" }, { amount: money(input.amountCents), reference: input.ref, customer: input.customer, reason: input.reason });
}

/**
 * The amount reserved on a booking's card lapsed before the site could take it:
 * the card was not charged, and the booking, which stands, owes `dueCents`.
 * Sent only while it owes something: the studio may have collected it already.
 */
export function ownerReservationLapsedNotice(input: { to: string; ref: string; customer: string; amountCents: number; dueCents: number }): QueuedEmail {
  return written("owner_reservation_lapsed", { to: input.to, kind: "owner_reservation_lapsed" }, { amount: money(input.amountCents), reference: input.ref, customer: input.customer, due: money(input.dueCents) });
}

/** The client's side of `ownerReservationLapsedNotice`: their card was not charged, and the booking, which stands, is still to pay. */
export function reservationLapsedEmail(input: { to: string; name: string; ref: string; when: string; dueCents: number }): QueuedEmail {
  return written(
    "reservation_lapsed",
    { to: input.to, kind: "reservation_lapsed" },
    { name: input.name, reference: input.ref, when: input.when, due: money(input.dueCents) },
  );
}

/** A membership bought on the site (follow-up 3): its code, and how it is billed and cancelled. */
export function membershipStartedEmail(input: {
  to: string;
  name: string;
  planName: string;
  /** The studio minutes each month. */
  minutes: number;
  priceCents: number;
  code: string;
  /** The day the next month is billed, `YYYY-MM-DD`. */
  nextBilling: string;
  bookUrl: string;
  accountUrl: string;
}): QueuedEmail {
  return written(
    "membership_started",
    { to: input.to, kind: "membership_started" },
    {
      name: input.name,
      plan: input.planName,
      hours: durationLabel(input.minutes),
      price: money(input.priceCents),
      code: input.code,
      book_link: input.bookUrl,
      next_billing: longDateLabel(input.nextBilling),
      account_link: input.accountUrl,
    },
  );
}

/** A month of a membership paid (follow-up 3): its hours are on the code. */
export function membershipMonthPaidEmail(input: {
  to: string;
  name: string;
  planName: string;
  minutes: number;
  priceCents: number;
  code: string;
  minutesLeft: number;
  /** The day the next month is billed, `YYYY-MM-DD`. */
  nextBilling: string;
  accountUrl: string;
}): QueuedEmail {
  return written(
    "membership_month_paid",
    { to: input.to, kind: "membership_month_paid" },
    {
      name: input.name,
      plan: input.planName,
      hours: durationLabel(input.minutes),
      price: money(input.priceCents),
      code: input.code,
      hours_left: durationLabel(input.minutesLeft),
      next_billing: longDateLabel(input.nextBilling),
      account_link: input.accountUrl,
    },
  );
}

/** A month of a membership not paid, or its monthly payments stopped (follow-up 3): to the member. */
export function membershipProblemEmail(input: { to: string; name: string; planName: string; problem: string; code: string; minutesLeft: number }): QueuedEmail {
  return written(
    "membership_payment_problem",
    { to: input.to, kind: "membership_payment_problem" },
    {
      name: input.name,
      plan: input.planName,
      problem: input.problem,
      code: input.code,
      hours_left: input.minutesLeft > 0 ? durationLabel(input.minutesLeft) : "none at the moment",
    },
  );
}

/** The studio's side of `membershipProblemEmail`: what went wrong, and that the member was told. */
export function ownerMembershipProblemNotice(input: { to: string; code: string; customer: string; planName: string; problem: string }): QueuedEmail {
  return written("owner_membership_problem", { to: input.to, kind: "owner_membership_problem" }, { customer: input.customer, code: input.code, plan: input.planName, problem: input.problem });
}

/**
 * A client pressed to join and no answer came about their card, so the membership was not started; an hour on, the site
 * gave it up. Square may have taken the payment all the same.
 */
export function ownerMembershipUnfinishedNotice(input: { to: string; code: string; customer: string; planName: string; amountCents: number }): QueuedEmail {
  return written("owner_membership_unfinished", { to: input.to, kind: "owner_membership_unfinished" }, { customer: input.customer, plan: input.planName, amount: money(input.amountCents), code: input.code });
}

/** A membership cancelled (follow-up 3): no more payments, and the hours left stay usable. */
export function membershipCancelledEmail(input: {
  to: string;
  name: string;
  planName: string;
  code: string;
  /** The day the month paid for ends, `YYYY-MM-DD`, when it runs on after the cancellation. */
  endsOn: string | null;
  minutesLeft: number;
  bookUrl: string;
}): QueuedEmail {
  return written(
    "membership_cancelled",
    { to: input.to, kind: "membership_cancelled" },
    {
      name: input.name,
      plan: input.planName,
      ends: input.endsOn ? `The month you paid for runs until ${longDateLabel(input.endsOn)}.` : "No month you paid for runs on after it.",
      code: input.code,
      hours_left: input.minutesLeft > 0 ? durationLabel(input.minutesLeft) : "none at the moment",
      book_link: input.bookUrl,
    },
  );
}

/**
 * A membership was paid for and could not be set up, and the refund of its first month did not go through: the studio
 * refunds it by hand. The client was told the studio would.
 */
export function ownerMembershipRefundNotice(input: { to: string; code: string; customer: string; amountCents: number; reason: string }): QueuedEmail {
  return written("owner_membership_refund", { to: input.to, kind: "owner_membership_refund" }, { customer: input.customer, amount: money(input.amountCents), code: input.code, reason: input.reason });
}

/** A visitor's message from the contact page, sent to the owner. Replying reaches the visitor. */
export function contactMessageEmail(input: {
  to: string;
  name: string;
  email: string;
  topic: string;
  message: string;
}): QueuedEmail {
  return written(
    "contact_message",
    { to: input.to, kind: "contact_message", replyTo: input.email },
    { name: input.name, email: input.email, topic: input.topic, message: input.message },
  );
}
