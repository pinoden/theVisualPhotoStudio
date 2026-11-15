/**
 * What happens when a customer cancels or wants to move a booking.
 * Pure functions: the same answer is shown to the customer before they
 * confirm and applied by the server when they do.
 */

export interface PolicySettings {
  refundWindowHours: number;
  refundFeePercent: number;
  rescheduleCutoffHours: number;
  maxReschedules: number;
}

export interface BookingFacts {
  status: string;
  startAt: Date;
  /** How many times the money behind this booking has already been moved. */
  rescheduledCount: number;
  /** Paid by card and not yet refunded. */
  cardPaidCents: number;
  /** Paid with a reschedule credit (money from an earlier booking). */
  creditAppliedCents: number;
  /** Taken off the price by a percent code (a loyalty code, for example). That code is used up. */
  discountCents: number;
}

export type CancelBlock = "not_confirmed" | "already_started";

export type CancelOutcome =
  | { allowed: false; reason: CancelBlock }
  | {
      allowed: true;
      refundCents: number;
      feeCents: number;
      /** Why the refund is what it is. */
      why: "refund" | "inside_window" | "rescheduled" | "nothing_paid";
    };

const HOUR = 3_600_000;

function hoursUntil(startAt: Date, now: Date): number {
  return (startAt.getTime() - now.getTime()) / HOUR;
}

export function cancellationOutcome(booking: BookingFacts, now: Date, settings: PolicySettings): CancelOutcome {
  if (booking.status !== "confirmed") return { allowed: false, reason: "not_confirmed" };
  if (now.getTime() >= booking.startAt.getTime()) return { allowed: false, reason: "already_started" };

  if (booking.rescheduledCount > 0) return { allowed: true, refundCents: 0, feeCents: 0, why: "rescheduled" };
  if (booking.cardPaidCents <= 0) return { allowed: true, refundCents: 0, feeCents: 0, why: "nothing_paid" };
  if (hoursUntil(booking.startAt, now) < settings.refundWindowHours) {
    return { allowed: true, refundCents: 0, feeCents: 0, why: "inside_window" };
  }
  const feeCents = Math.round((booking.cardPaidCents * settings.refundFeePercent) / 100);
  return { allowed: true, refundCents: booking.cardPaidCents - feeCents, feeCents, why: "refund" };
}

export type RescheduleBlock =
  | "not_confirmed"
  | "already_started"
  /** The owner has switched moving off (`maxReschedules` is 0). */
  | "not_offered"
  | "too_late"
  | "limit_reached"
  | "nothing_paid";

export type RescheduleOutcome =
  | { allowed: false; reason: RescheduleBlock }
  | {
      allowed: true;
      /** What the new code is worth. */
      creditCents: number;
      /** The part of it that is the discount a percent code gave on this booking, not money paid. */
      discountCents: number;
    };

/**
 * Whether the customer can turn this booking into a credit code for a new one.
 *
 * The code is worth what was paid plus what a percent code took off. That
 * code was spent on this booking and does not come back, and checkout takes
 * one code, so without its value the same booking at a new time would cost
 * the discount a second time.
 */
export function rescheduleOutcome(booking: BookingFacts, now: Date, settings: PolicySettings): RescheduleOutcome {
  if (booking.status !== "confirmed") return { allowed: false, reason: "not_confirmed" };
  if (now.getTime() >= booking.startAt.getTime()) return { allowed: false, reason: "already_started" };
  if (settings.maxReschedules <= 0) return { allowed: false, reason: "not_offered" };
  if (booking.rescheduledCount >= settings.maxReschedules) return { allowed: false, reason: "limit_reached" };
  if (hoursUntil(booking.startAt, now) < settings.rescheduleCutoffHours) return { allowed: false, reason: "too_late" };
  const paidCents = booking.cardPaidCents + booking.creditAppliedCents;
  // A booking that cost nothing is cancelled instead: that gives its code back.
  if (paidCents <= 0) return { allowed: false, reason: "nothing_paid" };
  const discountCents = Math.max(0, booking.discountCents);
  return { allowed: true, creditCents: paidCents + discountCents, discountCents };
}
