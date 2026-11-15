import { describe, expect, it } from "vitest";
import { labelChange, labelOf, SETTABLE_LABELS, type LabelFacts } from "./labels";

const START = new Date("2026-11-18T15:00:00Z");
const END = new Date("2026-11-18T17:00:00Z");
const at = (minutesFromStart: number) => new Date(START.getTime() + minutesFromStart * 60_000);
const booking = (overrides: Partial<LabelFacts> = {}): LabelFacts => ({ status: "confirmed", label: null, startAt: START, endAt: END, ...overrides });

describe("the label a booking shows", () => {
  it("is its status once the visit is over or the booking is cancelled, whatever label it had", () => {
    expect(labelOf({ status: "completed", label: "checked_in" })).toBe("completed");
    expect(labelOf({ status: "no_show", label: null })).toBe("no_show");
    expect(labelOf({ status: "cancelled", label: "reschedule_pending" })).toBe("cancelled");
    expect(labelOf({ status: "expired", label: null })).toBe("cancelled");
  });

  it("is the label an administrator gave a confirmed booking, or plain Confirmed", () => {
    expect(labelOf({ status: "confirmed", label: null })).toBe("confirmed");
    expect(labelOf({ status: "confirmed", label: "checked_in" })).toBe("checked_in");
    expect(labelOf({ status: "confirmed", label: "reschedule_pending" })).toBe("reschedule_pending");
    expect(labelOf({ status: "confirmed", label: "rescheduled" })).toBe("rescheduled");
    expect(labelOf({ status: "confirmed", label: "something else" })).toBe("confirmed");
  });
});

describe("setting a label by hand", () => {
  it("keeps the booking confirmed, and so holding its time, for the three labels of a visit still to come", () => {
    const days = -3 * 24 * 60;
    expect(labelChange(booking(), "reschedule_pending", at(days))).toEqual({ ok: true, status: "confirmed", label: "reschedule_pending" });
    expect(labelChange(booking(), "rescheduled", at(days))).toEqual({ ok: true, status: "confirmed", label: "rescheduled" });
    expect(labelChange(booking(), "checked_in", at(-10))).toEqual({ ok: true, status: "confirmed", label: "checked_in" });
  });

  it("opens Checked In an hour before the start, and Completed and No Show at the start", () => {
    expect(labelChange(booking(), "checked_in", at(-61))).toEqual({ ok: false, reason: "too_early" });
    expect(labelChange(booking(), "checked_in", at(-60))).toMatchObject({ ok: true });
    for (const label of ["completed", "no_show"] as const) {
      expect(labelChange(booking(), label, at(-1))).toEqual({ ok: false, reason: "too_early" });
      expect(labelChange(booking(), label, at(0))).toEqual({ ok: true, status: label, label: null });
    }
  });

  it("no longer marks an appointment for rescheduling once it is over", () => {
    expect(labelChange(booking(), "reschedule_pending", at(119))).toMatchObject({ ok: true });
    expect(labelChange(booking(), "reschedule_pending", at(120))).toEqual({ ok: false, reason: "too_late" });
    expect(labelChange(booking(), "rescheduled", at(500))).toEqual({ ok: false, reason: "too_late" });
  });

  it("can be corrected: any label to any other, and back to none", () => {
    const noShow = booking({ status: "no_show" });
    expect(labelChange(noShow, "completed", at(200))).toEqual({ ok: true, status: "completed", label: null });
    expect(labelChange(noShow, "checked_in", at(200))).toEqual({ ok: true, status: "confirmed", label: "checked_in" });
    expect(labelChange(booking({ label: "reschedule_pending" }), "confirmed", at(-500))).toEqual({ ok: true, status: "confirmed", label: null });
  });

  it("says so when nothing would change", () => {
    expect(labelChange(booking(), "confirmed", at(0))).toEqual({ ok: false, reason: "unchanged" });
    expect(labelChange(booking({ label: "checked_in" }), "checked_in", at(0))).toEqual({ ok: false, reason: "unchanged" });
    expect(labelChange(booking({ status: "completed" }), "completed", at(200))).toEqual({ ok: false, reason: "unchanged" });
  });

  it("is not possible for a booking that is cancelled or was never paid for", () => {
    for (const status of ["cancelled", "expired", "pending_payment"]) {
      for (const label of SETTABLE_LABELS) {
        expect(labelChange(booking({ status }), label, at(10))).toEqual({ ok: false, reason: "not_active" });
      }
    }
  });
});
