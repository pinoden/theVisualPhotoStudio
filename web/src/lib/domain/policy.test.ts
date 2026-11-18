import { describe, expect, it } from "vitest";
import { cancellationOutcome, rescheduleOutcome, type BookingFacts, type PolicySettings } from "./policy";

/** The owner's terms since 2026-11-15: 14 days, 5% kept. */
const settings: PolicySettings = {
  refundWindowHours: 336,
  refundFeePercent: 5,
  rescheduleCutoffHours: 24,
  maxReschedules: 1,
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

describe("moving a booking", () => {
  it("turns everything paid into credit, including credit already used on it", () => {
    expect(rescheduleOutcome(booking(), hoursBefore(48), settings)).toEqual({
      allowed: true,
      creditCents: 17600,
      discountCents: 0,
    });
    expect(
      rescheduleOutcome(booking({ cardPaidCents: 2000, creditAppliedCents: 15600 }), hoursBefore(48), { ...settings, maxReschedules: 2 }),
    ).toEqual({ allowed: true, creditCents: 17600, discountCents: 0 });
  });

  it("adds what a discount code took off, so the same booking at a new time costs nothing more", () => {
    // A $176 booking made with a 10% code: $158.40 was paid, and the code is used up.
    expect(rescheduleOutcome(booking({ cardPaidCents: 15840, discountCents: 1760 }), hoursBefore(48), settings)).toEqual({
      allowed: true,
      creditCents: 17600,
      discountCents: 1760,
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

  it("stops at the limit of moves", () => {
    expect(rescheduleOutcome(booking({ rescheduledCount: 1 }), hoursBefore(48), settings)).toEqual({
      allowed: false,
      reason: "limit_reached",
    });
    expect(rescheduleOutcome(booking({ rescheduledCount: 1 }), hoursBefore(48), { ...settings, maxReschedules: 2 })).toMatchObject({
      allowed: true,
    });
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
    });
  });
});
