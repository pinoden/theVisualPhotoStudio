import { describe, expect, it } from "vitest";
import { cancellationOutcome, codeComesBack, rescheduleOutcome, type BookingFacts, type PolicySettings } from "./policy";

/** A photography session's terms: 14 days, 5% kept. A rental's are the same with 7 days (2026-11-17). */
const settings: PolicySettings = {
  refundWindowHours: 336,
  refundFeePercent: 5,
  rescheduleCutoffHours: 24,
  maxReschedules: 1,
  rescheduleFeeCents: 2000,
};

const START = new Date("2026-12-10T15:00:00Z");
const hoursBefore = (hours: number) => new Date(START.getTime() - hours * 3_600_000);

function booking(overrides: Partial<BookingFacts> = {}): BookingFacts {
  return {
    status: "confirmed",
    startAt: START,
    rescheduledCount: 0,
    cardPaidCents: 17600,
    creditAppliedCents: 0,
    discountCents: 0,
    ...overrides,
  };
}

describe("cancelling", () => {
  it("refunds the card payment less the fee when cancelled 14 or more days ahead", () => {
    expect(cancellationOutcome(booking(), hoursBefore(400), settings)).toEqual({
      allowed: true,
      refundCents: 16720,
      feeCents: 880,
      creditCents: 0,
      byHandCents: 0,
      why: "refund",
    });
    // Exactly 336 hours ahead still counts.
    expect(cancellationOutcome(booking(), hoursBefore(336), settings)).toMatchObject({ refundCents: 16720 });
  });

  it("refunds nothing inside the window", () => {
    expect(cancellationOutcome(booking(), hoursBefore(335.99), settings)).toEqual({
      allowed: true,
      refundCents: 0,
      feeCents: 0,
      creditCents: 0,
      byHandCents: 0,
      why: "inside_window",
    });
    // Ten days ahead was refunded while the window was 7 days.
    expect(cancellationOutcome(booking(), hoursBefore(240), settings)).toMatchObject({ refundCents: 0, why: "inside_window" });
  });

  it("keeps the pet fee out of the card refund and returns it as studio credit", () => {
    // $176 for the studio and $40 for the pet. The fee is taken on the $176 only; the $40 comes back whole, as credit.
    const withPet = booking({ cardPaidCents: 21600, petFeeCents: 4000 });
    expect(cancellationOutcome(withPet, hoursBefore(400), settings)).toEqual({
      allowed: true,
      refundCents: 16720,
      feeCents: 880,
      creditCents: 4000,
      byHandCents: 0,
      why: "refund",
      petFeeCents: 4000,
    });
    // Inside the window nothing comes back by itself, the pet fee included.
    expect(cancellationOutcome(withPet, hoursBefore(100), settings)).toMatchObject({ refundCents: 0, creditCents: 0, why: "inside_window" });
    // When an administrator has already returned it, it is not returned a second time, and it still stays off the card.
    expect(cancellationOutcome({ ...withPet, petCreditGiven: true }, hoursBefore(400), settings)).toMatchObject({
      refundCents: 16720,
      creditCents: 0,
    });
    // A booking of which a credit paid most: the card holds less than the pet fee, and all of it becomes credit.
    expect(cancellationOutcome(booking({ cardPaidCents: 1000, creditAppliedCents: 20600, petFeeCents: 4000 }), hoursBefore(400), settings)).toMatchObject({
      refundCents: 0,
      feeCents: 0,
      creditCents: 1000,
    });
  });

  it("leaves money taken at the studio to the studio: nothing is sent back online", () => {
    const paidInCash = booking({ cardPaidCents: 0, paidAtStudioCents: 17600 });
    expect(cancellationOutcome(paidInCash, hoursBefore(400), settings)).toEqual({
      allowed: true,
      refundCents: 0,
      feeCents: 0,
      creditCents: 0,
      byHandCents: 17600,
      why: "paid_at_studio",
    });
    // Inside the window no refund is due at all, so there is nothing for the studio to do either.
    expect(cancellationOutcome(paidInCash, hoursBefore(100), settings)).toMatchObject({ byHandCents: 0, why: "inside_window" });
    // Part by card, part at the studio: the card part goes back by itself, the rest by hand.
    expect(cancellationOutcome(booking({ cardPaidCents: 10000, paidAtStudioCents: 7600 }), hoursBefore(400), settings)).toMatchObject({
      refundCents: 9500,
      feeCents: 500,
      byHandCents: 7600,
      why: "refund",
    });
  });

  it("never refunds a booking that was already moved, however early", () => {
    expect(cancellationOutcome(booking({ rescheduledCount: 1 }), hoursBefore(500), settings)).toMatchObject({
      allowed: true,
      refundCents: 0,
      why: "rescheduled",
    });
  });

  it("refunds in full when the owner sets no fee, and rounds the fee to the cent", () => {
    expect(cancellationOutcome(booking(), hoursBefore(400), { ...settings, refundFeePercent: 0 })).toMatchObject({
      refundCents: 17600,
      feeCents: 0,
    });
    expect(cancellationOutcome(booking({ cardPaidCents: 13290 }), hoursBefore(400), settings)).toMatchObject({
      feeCents: 665, // 664.5 rounds up
      refundCents: 12625,
    });
  });

  it("has nothing to refund when nothing was paid by card", () => {
    expect(cancellationOutcome(booking({ cardPaidCents: 0 }), hoursBefore(400), settings)).toMatchObject({
      allowed: true,
      refundCents: 0,
      why: "nothing_paid",
    });
  });

  it("is not possible once the booking started or is no longer confirmed", () => {
    expect(cancellationOutcome(booking(), START, settings)).toEqual({ allowed: false, reason: "already_started" });
    expect(cancellationOutcome(booking(), hoursBefore(-1), settings)).toEqual({ allowed: false, reason: "already_started" });
    for (const status of ["cancelled", "completed", "no_show", "pending_payment", "expired"]) {
      expect(cancellationOutcome(booking({ status }), hoursBefore(400), settings)).toEqual({
        allowed: false,
        reason: "not_confirmed",
      });
    }
  });
});

describe("a late cancellation's credit code (the owner, 2026-11-28)", () => {
  // "If they cancel the booking between 7 and 2 days ... we will be issuing them a code for the booking automatically."
  const on = { ...settings, cancelCodeEnabled: true, cancelCodeUntilHours: 48 };

  it("gives what was paid as a code inside the refund window, until the hours the owners set, and nothing after", () => {
    expect(cancellationOutcome(booking(), hoursBefore(400), on)).toMatchObject({ why: "refund", refundCents: 16720 });
    expect(cancellationOutcome(booking(), hoursBefore(335), on)).toMatchObject({ why: "code", codeCents: 17600, refundCents: 0, feeCents: 0 });
    expect(cancellationOutcome(booking(), hoursBefore(48), on)).toMatchObject({ why: "code", codeCents: 17600 });
    expect(cancellationOutcome(booking(), hoursBefore(47.9), on)).toMatchObject({ why: "inside_window", refundCents: 0 });
    // Switched off, for a busy season: nothing inside the window, as before.
    expect(cancellationOutcome(booking(), hoursBefore(100), { ...on, cancelCodeEnabled: false })).toMatchObject({ why: "inside_window" });
    expect(cancellationOutcome(booking(), hoursBefore(100), settings)).toMatchObject({ why: "inside_window" });
  });

  it("counts every payment, studio credit and money paid at the studio included, but no discount and no pet fee returned twice", () => {
    expect(cancellationOutcome(booking({ cardPaidCents: 2000, creditAppliedCents: 15600, discountCents: 1760, paidAtStudioCents: 500 }), hoursBefore(100), on)).toMatchObject({ why: "code", codeCents: 18100 });
    // Paid with studio credit alone: the credit comes back as the code.
    expect(cancellationOutcome(booking({ cardPaidCents: 0, creditAppliedCents: 17600 }), hoursBefore(100), on)).toMatchObject({ why: "code", codeCents: 17600 });
    expect(cancellationOutcome(booking({ petFeeCents: 4000, petCreditGiven: true }), hoursBefore(100), on)).toMatchObject({ why: "code", codeCents: 13600 });
    // Nothing paid, or a booking that was moved: nothing.
    expect(cancellationOutcome(booking({ cardPaidCents: 0, discountCents: 17600 }), hoursBefore(100), on)).toMatchObject({ why: "nothing_paid" });
    expect(cancellationOutcome(booking({ rescheduledCount: 1, madeWithRescheduleCode: true }), hoursBefore(100), on)).toMatchObject({ why: "rescheduled" });
  });

  it("is for weekdays when a rental booked for a weekday gives it, while the owners keep that rule", () => {
    expect(cancellationOutcome(booking({ weekdayRental: true }), hoursBefore(100), { ...on, weekdayCodeOnWeekdays: true })).toMatchObject({ why: "code", weekdaysOnly: true });
    expect("weekdaysOnly" in cancellationOutcome(booking({ weekdayRental: true }), hoursBefore(100), on)).toBe(false);
  });
});

describe("cancelling a booking with a pet fee", () => {
  it("returns the fee as credit when it was paid at the studio, and leaves the rest to be refunded by hand", () => {
    // $78 of studio and a $40 pet fee, paid in cash at the studio.
    const atStudio = booking({ cardPaidCents: 0, paidAtStudioCents: 11800, petFeeCents: 4000 });
    expect(cancellationOutcome(atStudio, hoursBefore(400), settings)).toEqual({
      allowed: true,
      refundCents: 0,
      feeCents: 0,
      creditCents: 4000,
      byHandCents: 7800,
      why: "paid_at_studio",
      petFeeCents: 4000,
    });
    // Already returned as credit: it is not returned again, and still not refunded.
    expect(cancellationOutcome({ ...atStudio, petCreditGiven: true }, hoursBefore(400), settings)).toMatchObject({ creditCents: 0, byHandCents: 7800 });
    // Paid partly by card: the fee comes off the card first, then off what was paid at the studio.
    expect(cancellationOutcome(booking({ cardPaidCents: 2000, paidAtStudioCents: 9800, petFeeCents: 4000 }), hoursBefore(400), settings)).toMatchObject({
      refundCents: 0,
      creditCents: 4000,
      byHandCents: 7800,
    });
  });
});

describe("the code or credit a cancelled booking was made with", () => {
  const rule = { refundWindowHours: 168, lateCancelKeepsCode: false };
  it("comes back when the client cancels in time for a refund, and is used up later or once the booking was moved (the owners' decision of 2026-11-27)", () => {
    expect(codeComesBack(booking(), hoursBefore(200), rule)).toBe(true);
    expect(codeComesBack(booking(), hoursBefore(168), rule)).toBe(true);
    expect(codeComesBack(booking(), hoursBefore(167.9), rule)).toBe(false);
    expect(codeComesBack(booking(), hoursBefore(2), rule)).toBe(false);
    // A moved booking is refunded at no time, and gives nothing back either.
    expect(codeComesBack(booking({ rescheduledCount: 1 }), hoursBefore(500), rule)).toBe(false);
    // A session has its own window, kept with the booking.
    expect(codeComesBack(booking(), hoursBefore(200), { ...rule, refundWindowHours: 336 })).toBe(false);
  });

  it("comes back after any cancellation while the owners keep the rule as it was", () => {
    const kept = { ...rule, lateCancelKeepsCode: true };
    expect(codeComesBack(booking(), hoursBefore(2), kept)).toBe(true);
    expect(codeComesBack(booking({ rescheduledCount: 2 }), hoursBefore(2), kept)).toBe(true);
  });
});

describe("moving a booking", () => {
  it("says that the code is for weekdays when a rental booked for a weekday is released, while the owners keep that rule (2026-11-28)", () => {
    const on = { ...settings, weekdayCodeOnWeekdays: true };
    expect(rescheduleOutcome(booking({ weekdayRental: true }), hoursBefore(48), on)).toMatchObject({ allowed: true, weekdaysOnly: true });
    // A weekend's booking, a session, or the rule switched off: nothing is said, and the code is for any day.
    for (const outcome of [rescheduleOutcome(booking(), hoursBefore(48), on), rescheduleOutcome(booking({ weekdayRental: false }), hoursBefore(48), on), rescheduleOutcome(booking({ weekdayRental: true }), hoursBefore(48), settings)]) {
      expect(outcome.allowed).toBe(true);
      expect("weekdaysOnly" in outcome).toBe(false);
    }
  });

  it("turns everything paid into credit, including credit already used on it", () => {
    expect(rescheduleOutcome(booking(), hoursBefore(48), settings)).toEqual({
      allowed: true,
      creditCents: 17600,
      discountCents: 0,
      // The one free move is this one: the new booking is then the studio's to move, for the fee.
      nextMovable: false,
      nextFeeCents: 2000,
    });
    expect(
      rescheduleOutcome(booking({ cardPaidCents: 2000, creditAppliedCents: 15600 }), hoursBefore(48), { ...settings, maxReschedules: 2 }),
    ).toEqual({ allowed: true, creditCents: 17600, discountCents: 0, nextMovable: true, nextFeeCents: 0 });
  });

  it("adds what a discount code took off, so the same booking at a new time costs nothing more", () => {
    // A $176 booking made with a 10% code: $158.40 was paid, and the code is used up.
    expect(rescheduleOutcome(booking({ cardPaidCents: 15840, discountCents: 1760 }), hoursBefore(48), settings)).toEqual({
      allowed: true,
      creditCents: 17600,
      discountCents: 1760,
      // The one free move is this one: the new booking is then the studio's to move, for the fee.
      nextMovable: false,
      nextFeeCents: 2000,
    });
    // A booking that a code made free is cancelled instead, which gives the code back.
    expect(rescheduleOutcome(booking({ cardPaidCents: 0, discountCents: 17600 }), hoursBefore(48), settings)).toEqual({
      allowed: false,
      reason: "nothing_paid",
    });
  });

  it("leaves out a pet fee that was already returned as studio credit, which was given back once", () => {
    // $78 of studio and a $40 pet fee, by card. With the fee still held, all of it moves.
    const withPet = booking({ cardPaidCents: 11800, petFeeCents: 4000 });
    expect(rescheduleOutcome(withPet, hoursBefore(48), settings)).toMatchObject({ allowed: true, creditCents: 11800 });
    expect(rescheduleOutcome({ ...withPet, petCreditGiven: true }, hoursBefore(48), settings)).toEqual({
      allowed: true,
      creditCents: 7800,
      discountCents: 0,
      // The one free move is this one: the new booking is then the studio's to move, for the fee.
      nextMovable: false,
      nextFeeCents: 2000,
    });
  });

  it("is allowed inside the refund window, which is when it matters most", () => {
    expect(rescheduleOutcome(booking(), hoursBefore(30), settings)).toMatchObject({ allowed: true });
  });

  it("stops at the cut-off before the start", () => {
    expect(rescheduleOutcome(booking(), hoursBefore(24), settings)).toMatchObject({ allowed: true });
    expect(rescheduleOutcome(booking(), hoursBefore(23.9), settings)).toEqual({ allowed: false, reason: "too_late" });
    expect(rescheduleOutcome(booking(), hoursBefore(0.5), { ...settings, rescheduleCutoffHours: 0 })).toMatchObject({ allowed: true });
  });

  it("is offered online only while a free move is left: a further one is the studio's to make (the owners' decision of 2026-11-20)", () => {
    // A booking made with a reschedule code: $176 of credit paid for it. Until 2026-11-27 it could be moved again
    // online, with $20 taken off the new code.
    const moved = booking({ rescheduledCount: 1, cardPaidCents: 0, creditAppliedCents: 17600 });
    expect(rescheduleOutcome(moved, hoursBefore(48), settings)).toEqual({ allowed: false, reason: "limit_reached" });
    expect(rescheduleOutcome(booking({ rescheduledCount: 2, cardPaidCents: 2000, creditAppliedCents: 15600 }), hoursBefore(48), settings)).toEqual({
      allowed: false,
      reason: "limit_reached",
    });
    // With two free moves, both are made online, and the code is worth everything paid each time.
    const twoFree = { ...settings, maxReschedules: 2 };
    expect(rescheduleOutcome(booking(), hoursBefore(48), twoFree)).toMatchObject({ allowed: true, creditCents: 17600, nextMovable: true, nextFeeCents: 0 });
    expect(rescheduleOutcome(booking({ rescheduledCount: 1 }), hoursBefore(48), twoFree)).toMatchObject({ allowed: true, creditCents: 17600, nextMovable: false, nextFeeCents: 2000 });
    expect(rescheduleOutcome(booking({ rescheduledCount: 2 }), hoursBefore(48), twoFree)).toEqual({ allowed: false, reason: "limit_reached" });
    // Whether a fee is set changes nothing online: it is what the studio's move costs afterwards.
    const noFee = { ...settings, rescheduleFeeCents: 0 };
    expect(rescheduleOutcome(booking({ rescheduledCount: 1 }), hoursBefore(48), noFee)).toEqual({ allowed: false, reason: "limit_reached" });
    expect(rescheduleOutcome(booking(), hoursBefore(48), noFee)).toMatchObject({ allowed: true, nextMovable: false, nextFeeCents: 0 });
  });

  it("says what the studio's move of the new booking would cost by the terms that booking will be made under", () => {
    // The new booking takes today's settings (question 10). Moving switched off since: the terms then say nothing of a
    // move, and the studio's costs nothing.
    expect(rescheduleOutcome(booking(), hoursBefore(48), settings, { maxReschedules: 0, rescheduleFeeCents: 2000 })).toMatchObject({ allowed: true, nextMovable: false, nextFeeCents: 0 });
    expect(rescheduleOutcome(booking(), hoursBefore(48), settings, { maxReschedules: 1, rescheduleFeeCents: 3500 })).toMatchObject({ allowed: true, nextMovable: false, nextFeeCents: 3500 });
    expect(rescheduleOutcome(booking(), hoursBefore(48), settings, { maxReschedules: 3, rescheduleFeeCents: 3500 })).toMatchObject({ allowed: true, nextMovable: true, nextFeeCents: 0 });
  });

  it("says moving is not offered, not that the booking was already moved, when the owner switched it off", () => {
    expect(rescheduleOutcome(booking(), hoursBefore(48), { ...settings, maxReschedules: 0 })).toEqual({
      allowed: false,
      reason: "not_offered",
    });
  });

  it("is not possible for started, unconfirmed or unpaid bookings", () => {
    expect(rescheduleOutcome(booking(), hoursBefore(-2), settings)).toEqual({ allowed: false, reason: "already_started" });
    expect(rescheduleOutcome(booking({ status: "cancelled" }), hoursBefore(48), settings)).toEqual({
      allowed: false,
      reason: "not_confirmed",
    });
    expect(rescheduleOutcome(booking({ cardPaidCents: 0 }), hoursBefore(48), settings)).toEqual({
      allowed: false,
      reason: "nothing_paid",
    });
  });

  it("moves money taken at the studio like any other", () => {
    expect(rescheduleOutcome(booking({ cardPaidCents: 0, paidAtStudioCents: 17600 }), hoursBefore(48), settings)).toEqual({
      allowed: true,
      creditCents: 17600,
      discountCents: 0,
      // The one free move is this one: the new booking is then the studio's to move, for the fee.
      nextMovable: false,
      nextFeeCents: 2000,
    });
  });
});
