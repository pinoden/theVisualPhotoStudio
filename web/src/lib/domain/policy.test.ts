import { describe, expect, it } from "vitest";
import { cancellationOutcome, rescheduleOutcome, type BookingFacts, type PolicySettings } from "./policy";

const settings: PolicySettings = {
  refundWindowHours: 168,
  refundFeePercent: 5,
  rescheduleCutoffHours: 24,
  maxReschedules: 1,
};

const START = new Date("2026-12-10T15:00:00Z");
const hoursBefore = (hours: number) => new Date(START.getTime() - hours * 3_600_000);

function booking(overrides: Partial<BookingFacts> = {}): BookingFacts {
  return { status: "confirmed", startAt: START, rescheduledCount: 0, cardPaidCents: 17600, creditAppliedCents: 0, ...overrides };
}

describe("cancelling", () => {
  it("refunds the card payment less the fee when cancelled 7 or more days ahead", () => {
    expect(cancellationOutcome(booking(), hoursBefore(200), settings)).toEqual({
      allowed: true,
      refundCents: 16720,
      feeCents: 880,
      why: "refund",
    });
    // Exactly 168 hours ahead still counts.
    expect(cancellationOutcome(booking(), hoursBefore(168), settings)).toMatchObject({ refundCents: 16720 });
  });

  it("refunds nothing inside the window", () => {
    expect(cancellationOutcome(booking(), hoursBefore(167.99), settings)).toEqual({
      allowed: true,
      refundCents: 0,
      feeCents: 0,
      why: "inside_window",
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
    expect(cancellationOutcome(booking(), hoursBefore(200), { ...settings, refundFeePercent: 0 })).toMatchObject({
      refundCents: 17600,
      feeCents: 0,
    });
    expect(cancellationOutcome(booking({ cardPaidCents: 13290 }), hoursBefore(200), settings)).toMatchObject({
      feeCents: 665, // 664.5 rounds up
      refundCents: 12625,
    });
  });

  it("has nothing to refund when nothing was paid by card", () => {
    expect(cancellationOutcome(booking({ cardPaidCents: 0 }), hoursBefore(200), settings)).toMatchObject({
      allowed: true,
      refundCents: 0,
      why: "nothing_paid",
    });
  });

  it("is not possible once the booking started or is no longer confirmed", () => {
    expect(cancellationOutcome(booking(), START, settings)).toEqual({ allowed: false, reason: "already_started" });
    expect(cancellationOutcome(booking(), hoursBefore(-1), settings)).toEqual({ allowed: false, reason: "already_started" });
    for (const status of ["cancelled", "completed", "no_show", "pending_payment", "expired"]) {
      expect(cancellationOutcome(booking({ status }), hoursBefore(200), settings)).toEqual({
        allowed: false,
        reason: "not_confirmed",
      });
    }
  });
});

describe("moving a booking", () => {
  it("turns everything paid into credit, including credit already used on it", () => {
    expect(rescheduleOutcome(booking(), hoursBefore(48), settings)).toEqual({ allowed: true, creditCents: 17600 });
    expect(
      rescheduleOutcome(booking({ cardPaidCents: 2000, creditAppliedCents: 15600 }), hoursBefore(48), { ...settings, maxReschedules: 2 }),
    ).toEqual({ allowed: true, creditCents: 17600 });
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
    expect(rescheduleOutcome(booking(), hoursBefore(48), { ...settings, maxReschedules: 0 })).toEqual({
      allowed: false,
      reason: "limit_reached",
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
});
