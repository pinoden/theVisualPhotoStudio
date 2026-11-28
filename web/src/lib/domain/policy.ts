/**
 * What happens when a customer cancels or wants to move a booking.
 * Pure functions: the same answer is shown to the customer before they
 * confirm and applied by the server when they do.
 */

export interface PolicySettings {
  refundWindowHours: number;
  refundFeePercent: number;
  rescheduleCutoffHours: number;
  /** How many moves are free of charge, which the client makes online. 0: moving is switched off. */
  maxReschedules: number;
  /**
   * What each move after the free ones costs. The studio makes those, at the client's request, and the fee is added to
   * what the booking owes (`moveBooking` in src/server/appointments.ts). 0: they cost nothing.
   */
  rescheduleFeeCents: number;
}

export interface BookingFacts {
  status: string;
  startAt: Date;
  /** How many times the money behind this booking has already been moved. */
  rescheduledCount: number;
  /**
   * Paid with a reschedule code: its money came from a booking that was
   * moved. False for a booking that the studio moved at the client's request,
   * which counts as moved too. Leave it out when it does not matter.
   */
  madeWithRescheduleCode?: boolean;
  /** Paid by card through the site and not yet refunded. */
  cardPaidCents: number;
  /** Paid with a reschedule credit (money from an earlier booking). */
  creditAppliedCents: number;
  /** Taken off the price by a percent code (a loyalty code, for example), with the sales tax it saved. That code is used up. */
  discountCents: number;
  /** Taken off the studios' prices by a sale the booking was made under (sale.ts), with the sales tax it saved. Left out: none. */
  saleCents?: number;
  /**
   * The pet fee on the booking. The owner's rule (2026-11-15): it is never
   * refunded to the card, and when the pet does not come it is returned as
   * studio credit. Leave it out for a booking without one.
   */
  petFeeCents?: number;
  /** The pet fee was already returned as studio credit, by an administrator. */
  petCreditGiven?: boolean;
  /**
   * Money taken at the studio and recorded by hand, not yet given back. The
   * site cannot send it anywhere: a refund of it is the studio's to make.
   */
  paidAtStudioCents?: number;
  /** Membership minutes the booking took (follow-up 3). Leave it out for a booking without any. */
  membershipMinutes?: number;
}

export type CancelBlock = "not_confirmed" | "already_started";

export type CancelOutcome =
  | { allowed: false; reason: CancelBlock }
  | {
      allowed: true;
      /** Sent back to the card. */
      refundCents: number;
      feeCents: number;
      /** The pet fee, returned as a code for studio credit instead of to the card. */
      creditCents: number;
      /**
       * Money taken at the studio that the terms say is refunded, before the
       * processing fee (`afterFee` gives what goes back): the studio does that by hand.
       */
      byHandCents: number;
      /** The booking's pet fee, when it has one: `creditCents` can be less, when part of it was refunded already. */
      petFeeCents?: number;
      /** Why the refund is what it is. */
      /** `rescheduled`: made with a reschedule code. `moved`: moved by the studio at the client's request. */
      why: "refund" | "inside_window" | "rescheduled" | "moved" | "nothing_paid" | "paid_at_studio";
    };

const HOUR = 3_600_000;

/**
 * What a refund of `cents` comes to once the processing fee is kept: for the
 * card, and for money paid at the studio that the studio gives back by hand.
 */
export function afterFee(cents: number, feePercent: number): number {
  return cents - Math.round((cents * feePercent) / 100);
}

function hoursUntil(startAt: Date, now: Date): number {
  return (startAt.getTime() - now.getTime()) / HOUR;
}

export function cancellationOutcome(booking: BookingFacts, now: Date, settings: PolicySettings): CancelOutcome {
  if (booking.status !== "confirmed") return { allowed: false, reason: "not_confirmed" };
  if (now.getTime() >= booking.startAt.getTime()) return { allowed: false, reason: "already_started" };

  type Allowed = Extract<CancelOutcome, { allowed: true }>;
  const nothing = (why: Allowed["why"]): Allowed => ({
    allowed: true,
    refundCents: 0,
    feeCents: 0,
    creditCents: 0,
    byHandCents: 0,
    why,
  });
  const atStudioCents = Math.max(0, booking.paidAtStudioCents ?? 0);
  if (booking.rescheduledCount > 0) return nothing(booking.madeWithRescheduleCode === false ? "moved" : "rescheduled");
  if (booking.cardPaidCents <= 0 && atStudioCents <= 0) return nothing("nothing_paid");
  if (hoursUntil(booking.startAt, now) < settings.refundWindowHours) return nothing("inside_window");
  // Cancelled in time. The pet fee stays out of every refund, and so out of the fee: it comes back whole, as credit,
  // taken first from what the card paid and then from what was paid at the studio, which is the studio's to give back.
  const petFeeCents = Math.max(0, booking.petFeeCents ?? 0);
  const petOnCard = Math.min(petFeeCents, booking.cardPaidCents);
  const petAtStudio = Math.min(petFeeCents - petOnCard, atStudioCents);
  const creditCents = booking.petCreditGiven ? 0 : petOnCard + petAtStudio;
  const byHandCents = atStudioCents - petAtStudio;
  const pet = petFeeCents > 0 ? { petFeeCents } : {};
  if (booking.cardPaidCents <= 0) return { ...nothing("paid_at_studio"), creditCents, byHandCents, ...pet };

  const refundable = booking.cardPaidCents - petOnCard;
  const refundCents = afterFee(refundable, settings.refundFeePercent);
  return { allowed: true, refundCents, feeCents: refundable - refundCents, creditCents, byHandCents, why: "refund", ...pet };
}

/**
 * Whether a cancellation by the client gives back the discount code, free hour or studio credit the booking was made
 * with: when the terms refund it (cancelled `refundWindowHours` or more before the start, and never moved), whatever
 * it was paid with. A cancellation that money would not come back from uses the code up too (the owners' decision of
 * 2026-11-27; until then a code came back after any cancellation). `lateCancelKeepsCode` is the owners' switch for the
 * rule as it was. A cancellation by the studio always gives it back, and is not asked here.
 */
export function codeComesBack(
  booking: Pick<BookingFacts, "startAt" | "rescheduledCount">,
  now: Date,
  settings: Pick<PolicySettings, "refundWindowHours"> & { lateCancelKeepsCode: boolean },
): boolean {
  if (settings.lateCancelKeepsCode) return true;
  return booking.rescheduledCount === 0 && hoursUntil(booking.startAt, now) >= settings.refundWindowHours;
}

export type RescheduleBlock =
  | "not_confirmed"
  | "already_started"
  /** The owner has switched moving off (`maxReschedules` is 0). */
  | "not_offered"
  | "too_late"
  /** The free moves are used: a further move is the studio's to make (`rescheduleFeeCents` each, when above 0). */
  | "limit_reached"
  | "nothing_paid"
  /**
   * Paid with membership minutes: such a booking is cancelled, which gives its minutes back from far enough ahead, and
   * booked again, rather than released for a reschedule code (the builder's reading, question 43).
   */
  | "membership";

export type RescheduleOutcome =
  | { allowed: false; reason: RescheduleBlock }
  | {
      allowed: true;
      /** What the new code is worth. */
      creditCents: number;
      /** The part of it that is no money paid: what a percent code and a sale took off this booking. */
      discountCents: number;
      /** The part of `discountCents` that a sale took off: there only when one did. */
      saleCents?: number;
      /**
       * Whether the new booking can be moved online again, by the terms it will be made under: only while free moves are
       * left, and not while the owners have moving switched off (the tester's third pass of 2026-11-18).
       */
      nextMovable: boolean;
      /** What the studio's move of the new booking would cost the client, once it cannot be moved online: 0 while it can. */
      nextFeeCents: number;
    };

/**
 * Whether the customer can turn this booking into a credit code for a new one.
 *
 * The code is worth what was paid plus what a percent code took off. That
 * code was spent on this booking and does not come back, and checkout takes
 * one code, so without its value the same booking at a new time would cost
 * the discount a second time.
 *
 * The client moves a booking online only while free moves are left
 * (`maxReschedules` of them: one, by the owner's terms). A further move is
 * the studio's to make, for `rescheduleFeeCents` each (the owners' decision
 * of 2026-11-20, built 2026-11-27). Until then a further move was offered
 * online, with the fee taken off the code.
 */
export function rescheduleOutcome(
  booking: BookingFacts,
  now: Date,
  settings: PolicySettings,
  /**
   * The terms the new booking will be made under: the settings of today, as a booking made with the code takes them
   * (question 10). What moving it again costs is theirs, not the released booking's (the tester's finding of 2026-11-18).
   */
  nextTerms: Pick<PolicySettings, "maxReschedules" | "rescheduleFeeCents"> = settings,
): RescheduleOutcome {
  if (booking.status !== "confirmed") return { allowed: false, reason: "not_confirmed" };
  if (now.getTime() >= booking.startAt.getTime()) return { allowed: false, reason: "already_started" };
  if ((booking.membershipMinutes ?? 0) > 0) return { allowed: false, reason: "membership" };
  if (settings.maxReschedules <= 0) return { allowed: false, reason: "not_offered" };
  if (booking.rescheduledCount >= settings.maxReschedules) return { allowed: false, reason: "limit_reached" };
  if (hoursUntil(booking.startAt, now) < settings.rescheduleCutoffHours) return { allowed: false, reason: "too_late" };
  // Money taken at the studio is held for the booking like any other, so it moves with it. A pet fee
  // already returned as studio credit was given back once: it does not move with the booking a second time.
  const returnedCents = booking.petCreditGiven ? Math.max(0, booking.petFeeCents ?? 0) : 0;
  const paidCents = booking.cardPaidCents + booking.creditAppliedCents + Math.max(0, booking.paidAtStudioCents ?? 0) - returnedCents;
  // A booking that cost nothing is cancelled instead: that gives its code back.
  if (paidCents <= 0) return { allowed: false, reason: "nothing_paid" };
  // What a sale took off travels like a discount code's saving: the same booking at a new time, when the sale is
  // over, costs nothing more (the builder's reading, question 87).
  const saleCents = Math.max(0, booking.saleCents ?? 0);
  const discountCents = Math.max(0, booking.discountCents) + saleCents;
  const nextMovable = booking.rescheduledCount + 1 < nextTerms.maxReschedules;
  // With moving switched off in the new booking's terms, they say nothing about a move: the studio's costs nothing.
  const nextFeeCents = nextMovable || nextTerms.maxReschedules <= 0 ? 0 : nextTerms.rescheduleFeeCents;
  return { allowed: true, creditCents: paidCents + discountCents, discountCents, ...(saleCents > 0 ? { saleCents } : {}), nextMovable, nextFeeCents };
}

/** Whose saving a reschedule code carries besides the money paid: "your discount code", "the sale price", or both. */
export function savingWords(amounts: { discountCents: number; saleCents?: number }): string {
  const sale = amounts.saleCents ?? 0;
  return sale <= 0 ? "your discount code" : sale >= amounts.discountCents ? "the sale price" : "your discount code and the sale price";
}
