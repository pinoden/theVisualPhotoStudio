import { and, asc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { bookings, paymentLinks, payments, promoCodes, refunds } from "@/db/schema";
import type { Db, DbLike } from "@/db/client";
import { labelOf } from "@/lib/domain/labels";
import { formatCents } from "@/lib/domain/pricing";
import { isPaymentMethod, MANUAL_PROVIDER, PAYMENT_METHODS, type PaymentMethod } from "@/lib/payment-methods";
import { can } from "@/lib/abilities";
import type { AuthUser } from "./auth";
import { isBookingRef } from "./bookings";
import { codeRefundEmail, paymentReceivedEmail, queueEmail } from "./email";
import { recordEvent } from "./history";
import { openPayLinkOf } from "./pay-links";
import { chargesCentsByBooking, creditLeftCentsByBooking, creditReturnedCentsByBooking, netCardPaidCents, netPaidCentsByBooking, owedCents, paidAtStudioCents, STANDS } from "./money";
import { RESERVE_HOURS } from "./payments";
import { petFeeCentsOf, petFeeReturnedCents, studioRefundableCents } from "./pet-fee";
import { codeStanding, rescheduleCodeOf, spendable, takeOffRescheduleCode } from "./promos";
import { loadSettings } from "./settings";
import { canViewDay } from "./staff";
import { formatInstant, localDateOf } from "./tz";

/**
 * Money taken at the studio, recorded by hand: "mark as paid".
 *
 * A booking an administrator makes for a client charges nothing online: the
 * client pays at the studio. What they pay is recorded here, so the booking
 * shows what is still owed and what was received, by whom it was recorded and
 * how it was paid. The site never moved this money, so it cannot send it
 * back: a refund of it is given by hand and recorded here as well.
 *
 * Every function checks the viewer itself. Owners can do all of it. Staff can
 * record a payment when the owners have switched that on
 * (`staffRecordsPayments`), on the days they may see; taking a record back
 * and recording a refund are the owners' alone.
 */

type BookingRow = typeof bookings.$inferSelect;

export interface PaymentLine {
  id: string;
  at: string;
  /** True for money taken at the studio and recorded by hand; false for a card charged through the site. */
  byHand: boolean;
  /** How it was paid, in words: "Cash", or "Card, online". */
  how: string;
  amountCents: number;
  refundedCents: number;
  /** A record taken back by an owner. It no longer counts. */
  voided: boolean;
  /** An amount the card holds reserved, not taken yet: it is not money received. */
  held: boolean;
  recordedBy: string | null;
  note: string;
  /**
   * The card processor that took it (`PaymentProvider.name`): "square" or "square-sandbox" for Square, whose receipt
   * the appointment's page opens; "mock" for the pretend one of test mode. Null for money taken at the studio.
   */
  processor: string | null;
}

export interface BookingMoney {
  /** What the booking costs: its price, and the extra charges added since (src/server/charges.ts). */
  totalCents: number;
  /** The part of `totalCents` that is extra charges. */
  chargesCents: number;
  /** Every payment that succeeded, before refunds. */
  receivedCents: number;
  /**
   * What was given back of what the booking was paid beyond its price (`creditReturnedCentsByBooking`): `receivedCents`
   * less this is what it was paid toward its price.
   */
  creditReturnedCents: number;
  /** What was paid and kept: every payment that succeeded, less every refund of it (`netPaidCentsByBooking`). */
  paidCents: number;
  /** What is still to pay (`owedCents`): nothing once the booking has ended. */
  dueCents: number;
  /**
   * What was paid beyond what the booking costs now (`creditLeftCentsByBooking`), for example after a move to a day
   * that costs less (follow-up 5). It is the client's, refunded by hand or once the studio agrees. Nothing for a
   * booking that ended.
   */
  creditLeftCents: number;
  /** What a refund to the card can still give back: what the card paid and kept, less a pet fee returned as credit. */
  cardRefundableCents: number;
  /** A card's amount for the booking was reserved and never taken, the reservation lapsing: no card paid it. */
  cardLapsed: boolean;
  /** How the booking ended, if it has: then nothing more is to pay, whatever was received. */
  ended: "cancelled" | "released" | null;
  /** Made in the admin, and so paid at the studio or through a payment link; else made online, and paid by card then. */
  madeInAdmin: boolean;
  /**
   * What the card holds reserved, not taken yet, and when the reservation lapses if it is not taken: taking it did not
   * go through, and the scheduled task tries again (src/server/reserved.ts). Null when the card holds nothing.
   */
  held: { cents: number; until: string; provider: string } | null;
  payments: PaymentLine[];
}

/** What a booking has received and still owes, with each payment. Failed and abandoned card attempts are left out. */
export async function moneyOf(
  db: DbLike,
  booking: Pick<BookingRow, "id" | "totalCents" | "madeBy" | "status" | "cancelReason">,
  now: Date = new Date(),
): Promise<BookingMoney> {
  const all = await db
    .select()
    .from(payments)
    .where(and(eq(payments.bookingId, booking.id), inArray(payments.status, ["succeeded", "voided", "authorized"])))
    .orderBy(asc(payments.createdAt));
  // An amount reserved counts while the card holds it: one that lapsed is a payment that failed (`owedCents`).
  const lapsedBefore = now.getTime() - RESERVE_HOURS * 3_600_000;
  const rows = all.filter((row) => row.status !== "authorized" || row.createdAt.getTime() > lapsedBefore);
  const reserved = rows.filter((row) => row.status === "authorized");
  const receivedCents = rows.filter((row) => row.status === "succeeded").reduce((sum, row) => sum + row.amountCents, 0);
  // The card payments that came in through a payment link, to say so beside them.
  const throughLink = new Set(
    (
      await db
        .select({ paymentId: paymentLinks.paymentId })
        .from(paymentLinks)
        .where(and(eq(paymentLinks.bookingId, booking.id), isNotNull(paymentLinks.paymentId)))
    ).map((row) => row.paymentId),
  );
  const charged = (await chargesCentsByBooking(db, [booking.id])).get(booking.id) ?? 0;
  const card = await netCardPaidCents(db, booking.id);
  return {
    totalCents: booking.totalCents + charged,
    chargesCents: charged,
    receivedCents,
    creditReturnedCents: (await creditReturnedCentsByBooking(db, [booking.id])).get(booking.id) ?? 0,
    paidCents: (await netPaidCentsByBooking(db, [booking.id])).get(booking.id) ?? 0,
    dueCents: await owedCents(db, booking, now),
    creditLeftCents: (await creditLeftCentsByBooking(db, [booking])).get(booking.id) ?? 0,
    cardRefundableCents: Math.max(0, card - Math.min(card, await petFeeReturnedCents(db, booking.id))),
    // Marked failed by the scheduled task, or run out before the task marked it (it may not run, nor ever mark another
    // processor's reservation), as what is owed counts it already (the tester's third pass of 2026-11-18).
    cardLapsed:
      all.some((row) => row.status === "authorized" && row.createdAt.getTime() <= lapsedBefore) ||
      (
        await db
          .select({ id: payments.id })
          .from(payments)
          .where(and(eq(payments.bookingId, booking.id), eq(payments.status, "failed"), ne(payments.provider, MANUAL_PROVIDER)))
          .limit(1)
      ).length > 0,
    madeInAdmin: booking.madeBy !== null,
    ended: STANDS.includes(booking.status) ? null : booking.cancelReason === "rescheduled" ? "released" : "cancelled",
    held:
      reserved.length > 0
        ? {
            cents: reserved.reduce((sum, row) => sum + row.amountCents, 0),
            until: new Date(Math.min(...reserved.map((row) => row.createdAt.getTime())) + RESERVE_HOURS * 3_600_000).toISOString(),
            // The card processor that reserved it: one the site does not ask is not taken by it.
            provider: reserved[0].provider,
          }
        : null,
    payments: rows.map((row) => ({
      id: row.id,
      at: row.createdAt.toISOString(),
      byHand: row.provider === MANUAL_PROVIDER,
      how:
        row.provider === MANUAL_PROVIDER
          ? isPaymentMethod(row.method)
            ? PAYMENT_METHODS[row.method]
            : "At the studio"
          : throughLink.has(row.id)
            ? "Card, through the payment link"
            : row.status === "authorized"
              ? "Card, online: held on the card, not taken yet"
              : "Card, online",
      amountCents: row.amountCents,
      refundedCents: row.refundedCents,
      voided: row.status === "voided",
      held: row.status === "authorized",
      recordedBy: row.recordedBy,
      note: row.note,
      processor: row.provider === MANUAL_PROVIDER ? null : row.provider,
    })),
  };
}

export type StudioPaymentBlock =
  | "forbidden"
  | "not_found"
  | "not_active"
  | "bad_amount"
  | "bad_method"
  | "nothing_due"
  | "too_much"
  /** A payment link is open for the booking: the client could pay it as well. */
  | "link_open";

export type StudioPaymentResult =
  | { ok: true; amountCents: number; dueCents: number }
  | { ok: false; reason: StudioPaymentBlock; message: string };

const refuse = (reason: StudioPaymentBlock, message: string) => ({ ok: false as const, reason, message });

/**
 * Record a payment taken at the studio for a booking: "mark as paid". The
 * amount can be all that is still owed or a part of it, never more. The
 * client is emailed a confirmation, and the booking's history gets a line.
 */
export async function recordStudioPayment(
  db: Db,
  viewer: AuthUser,
  ref: string,
  input: { amountCents: number; method: string; note: string },
  now: Date,
): Promise<StudioPaymentResult> {
  const settings = await loadSettings(db);
  if (!can(viewer, "recordPayments", settings)) return refuse("forbidden", "You cannot record payments.");
  if (!isBookingRef(ref)) return refuse("not_found", "Booking not found.");
  if (!isPaymentMethod(input.method)) return refuse("bad_method", "Choose how it was paid.");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return refuse("bad_amount", "Enter the amount that was paid, above zero.");
  }
  const method: PaymentMethod = input.method;

  return db.transaction(async (tx): Promise<StudioPaymentResult> => {
    // Locked, so two people recording the same cash at once cannot both be told it was still owed.
    const [booking] = await tx.select().from(bookings).where(eq(bookings.ref, ref)).for("update").limit(1);
    // Staff are told "forbidden" for an unknown reference too, so they cannot probe for bookings.
    if (!booking) return viewer.role === "owner" ? refuse("not_found", "Booking not found.") : refuse("forbidden", "You cannot record a payment for that booking.");
    if (!(await canViewDay(tx, viewer, localDateOf(booking.startAt)))) return refuse("forbidden", "You cannot record a payment for that booking.");
    if (!["confirmed", "completed", "no_show"].includes(booking.status)) {
      return refuse("not_active", "A payment can be recorded for a booking that is confirmed or has taken place, not for a cancelled one.");
    }
    const money = await moneyOf(tx, booking, now);
    if (money.dueCents <= 0) return refuse("nothing_due", "Nothing is owed for this booking.");
    const link = await openPayLinkOf(tx, booking.id);
    if (link) {
      return refuse(
        "link_open",
        `A payment link for ${formatCents(link.amountCents)} is open for this booking. Cancel the link before recording a payment by hand, so that the client cannot pay twice.`,
      );
    }
    if (input.amountCents > money.dueCents) {
      return refuse("too_much", `Only ${formatCents(money.dueCents)} is still to pay for this booking.`);
    }

    await tx.insert(payments).values({
      bookingId: booking.id,
      provider: MANUAL_PROVIDER,
      amountCents: input.amountCents,
      status: "succeeded",
      method,
      recordedBy: viewer.email,
      note: input.note.slice(0, 200),
      createdAt: now,
    });
    const dueCents = money.dueCents - input.amountCents;
    const label = labelOf(booking);
    await recordEvent(tx, {
      bookingId: booking.id,
      from: label,
      to: label,
      actor: viewer.email,
      at: now,
      note: `Payment of ${formatCents(input.amountCents)} recorded (${PAYMENT_METHODS[method].toLowerCase()})${
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
        amountCents: input.amountCents,
        method: PAYMENT_METHODS[method],
        dueCents,
      }),
    );
    return { ok: true, amountCents: input.amountCents, dueCents };
  });
}

export type RecordChangeResult = { ok: true } | { ok: false; message: string };

/** The payment recorded by hand that an owner wants to change, locked together with its booking. */
async function manualPaymentForUpdate(tx: DbLike, paymentId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(paymentId)) return null;
  const [row] = await tx
    .select({ payment: payments, booking: bookings })
    .from(payments)
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .where(and(eq(payments.id, paymentId), eq(payments.provider, MANUAL_PROVIDER)))
    .for("update")
    .limit(1);
  return row ?? null;
}

/**
 * Take back a payment that was recorded by mistake. The record stays, marked
 * as taken back, and no longer counts: the booking owes that amount again.
 * Not for money that was really paid and then given back: record that as a
 * refund instead.
 */
/** `owesAgain`: the booking still stands, so it owes the amount again; one that has ended owes nothing (`STANDS`). */
export type VoidResult = { ok: true; owesAgain: boolean } | { ok: false; message: string };

export async function voidStudioPayment(db: Db, viewer: AuthUser, paymentId: string, reason: string, now: Date): Promise<VoidResult> {
  if (viewer.role !== "owner") return { ok: false, message: "Only an owner can take a payment record back." };
  return db.transaction(async (tx): Promise<VoidResult> => {
    const found = await manualPaymentForUpdate(tx, paymentId);
    if (!found) return { ok: false, message: "That payment record was not found." };
    const { payment, booking } = found;
    if (payment.status !== "succeeded") return { ok: false, message: "That payment record was already taken back." };
    if (payment.refundedCents > 0) {
      return { ok: false, message: "A refund is recorded against that payment, so it was really paid and cannot be taken back." };
    }
    // Money that came back as a code of studio credit, the pet fee's or a reschedule code's, is not taken back while the
    // code can be spent, nor once it paid for a booking: the record goes only once the code is cancelled, or ran out unspent.
    const [credit] = await tx
      .select({ id: promoCodes.id })
      .from(promoCodes)
      .where(and(eq(promoCodes.originBookingId, booking.id), eq(promoCodes.source, "pet_fee")))
      .limit(1);
    const held = (await netCardPaidCents(tx, booking.id)) + (await paidAtStudioCents(tx, booking.id)) + booking.creditAppliedCents - payment.amountCents;
    if (credit && held < (await petFeeCentsOf(tx, booking.id))) {
      const standing = await codeStanding(tx, credit.id, now);
      if (standing.usedCents > 0) {
        return {
          ok: false,
          message: `The pet fee of this booking came back as studio credit (code ${standing.code}), and ${formatCents(standing.usedCents)} of it was used: this record cannot be taken back.`,
        };
      }
      if (standing.usable) {
        return {
          ok: false,
          message: `The pet fee of this booking was returned as studio credit (code ${standing.code}) for what was paid. Cancel that code under Codes first, then take this record back.`,
        };
      }
    }
    const moved = await rescheduleCodeOf(tx, booking.id);
    if (moved) {
      const standing = await codeStanding(tx, moved.id, now);
      if (standing.usedCents > 0) {
        return {
          ok: false,
          message: `This booking's money went into its reschedule code ${moved.code}, and ${formatCents(standing.usedCents)} of it was spent or refunded: this record cannot be taken back.`,
        };
      }
      if (standing.usable) {
        return {
          ok: false,
          message: `This booking's money went into its reschedule code ${moved.code} (${formatCents(moved.valueCents)} left). Cancel that code under Codes first, then take this record back.`,
        };
      }
    }
    const why = reason.trim().slice(0, 200);
    await tx
      .update(payments)
      .set({ status: "voided", error: `Taken back by ${viewer.email}${why ? `: ${why}` : ""}` })
      .where(eq(payments.id, payment.id));
    const label = labelOf(booking);
    await recordEvent(tx, {
      bookingId: booking.id,
      from: label,
      to: label,
      actor: viewer.email,
      at: now,
      note: `Payment record of ${formatCents(payment.amountCents)} taken back${why ? `: ${why}` : ""}`,
    });
    return { ok: true, owesAgain: STANDS.includes(booking.status) };
  });
}

/**
 * Record a refund the studio gave by hand, of money it took at the studio.
 * Nothing is sent anywhere: this is the record of what a person did.
 */
export async function recordHandRefund(
  db: Db,
  viewer: AuthUser,
  paymentId: string,
  input: { amountCents: number; note: string },
  now: Date,
): Promise<RecordChangeResult> {
  if (viewer.role !== "owner") return { ok: false, message: "Only an owner can record a refund." };
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { ok: false, message: "Enter the amount that was given back, above zero." };
  }
  return db.transaction(async (tx): Promise<RecordChangeResult> => {
    const found = await manualPaymentForUpdate(tx, paymentId);
    if (!found) return { ok: false, message: "That payment record was not found." };
    const { payment, booking } = found;
    if (payment.status !== "succeeded") return { ok: false, message: "That payment record was taken back, so there is nothing to refund." };
    const left = payment.amountCents - payment.refundedCents;
    if (input.amountCents > left) {
      return { ok: false, message: `At most ${formatCents(left)} of that payment can still be refunded.` };
    }
    // A pet fee already returned as studio credit is not given back in cash as well, nor what is on a reschedule code.
    const back = await studioRefundableCents(tx, booking.id);
    const tooMuch = () => {
      // The part of the pet fee that came out of what was paid at the studio: the credit may have been only part of the fee.
      const why = [
        ...(back.petReturnedCents > 0
          ? [
              back.petReturnedCents < back.petFeeCents
                ? `${formatCents(back.petReturnedCents)} of what was paid at the studio was for the pet fee, which was returned as studio credit`
                : `its pet fee (${formatCents(back.petFeeCents)}) was already returned as studio credit`,
            ]
          : []),
        ...(back.code ? [`what was paid is on its reschedule code ${back.code.code}, which has ${formatCents(back.code.valueCents)} left`] : []),
      ];
      return { ok: false as const, message: `At most ${formatCents(back.cents)} can be refunded by hand for this booking${why.length > 0 ? `: ${why.join("; ")}` : ""}.` };
    };
    if (input.amountCents > back.cents) return tooMuch();
    // What a released booking gives back comes off its code, and the client is told.
    if (back.code && !(await takeOffRescheduleCode(tx, back.code.id, input.amountCents))) return tooMuch();
    if (back.code) {
      await queueEmail(
        tx,
        codeRefundEmail({
          to: booking.customerEmail,
          name: booking.customerName,
          ref: booking.ref,
          code: back.code.code,
          cents: input.amountCents,
          leftCents: back.code.valueCents - input.amountCents,
          usable: spendable(back.code, now),
          byHand: true,
        }),
      );
    }
    const why = input.note.trim().slice(0, 180);
    // Given back while the booking was paid beyond its price: that part first, which it owes again should its price go
    // up again (`paidTowardPriceCentsByBooking`); the rest is the studio's goodwill.
    const creditLeft = (await creditLeftCentsByBooking(tx, [booking])).get(booking.id) ?? 0;
    await tx.insert(refunds).values({
      paymentId: payment.id,
      amountCents: input.amountCents,
      creditCents: Math.min(creditLeft, input.amountCents),
      status: "succeeded",
      reason: why || `Refunded by hand for ${booking.ref}`,
      automatic: false,
      createdAt: now,
      // Given back at the studio: made, not on its way.
      settledAt: now,
    });
    await tx
      .update(payments)
      .set({ refundedCents: sql`${payments.refundedCents} + ${input.amountCents}` })
      .where(eq(payments.id, payment.id));
    const label = labelOf(booking);
    await recordEvent(tx, {
      bookingId: booking.id,
      from: label,
      to: label,
      actor: viewer.email,
      at: now,
      note: `Refund of ${formatCents(input.amountCents)} given by hand${why ? `: ${why}` : ""}${
        back.code ? `; taken off the reschedule code ${back.code.code}, which has ${formatCents(back.code.valueCents - input.amountCents)} left` : ""
      }`,
    });
    return { ok: true };
  });
}
