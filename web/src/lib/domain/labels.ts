/**
 * The status label of an appointment: what an administrator sees and sets.
 *
 * A booking has a `status` that the rest of the site depends on (a confirmed
 * booking holds its time, a completed one counts as a visit) and, while it is
 * confirmed, an optional `label` on top of it. The three labels that leave a
 * booking confirmed are stored in `label`; Completed and No Show are statuses.
 * So nothing that asks "is this booking active?" had to learn the new labels,
 * and Reschedule Pending keeps the time slot simply by staying confirmed.
 */

export const LABEL_TEXT = {
  confirmed: "Confirmed",
  checked_in: "Checked In",
  completed: "Completed",
  rescheduled: "Rescheduled",
  no_show: "No Show",
  reschedule_pending: "Reschedule Pending",
  cancelled: "Cancelled",
} as const;

export type LabelKey = keyof typeof LABEL_TEXT;

/** What each label means, in the owner's words. Shown next to the buttons. */
export const LABEL_MEANING: Record<SettableLabel, string> = {
  confirmed: "Booked, with no label.",
  checked_in: "The client has arrived and checked in.",
  completed: "The appointment has finished.",
  rescheduled: "The appointment has been moved to a new date or time.",
  no_show: "The client did not arrive.",
  reschedule_pending: "The client has asked to reschedule but has not chosen a new time. The slot stays held.",
};

/** The labels an administrator can set by hand. "confirmed" takes a label off again. */
export const SETTABLE_LABELS = ["confirmed", "checked_in", "completed", "rescheduled", "no_show", "reschedule_pending"] as const;
export type SettableLabel = (typeof SETTABLE_LABELS)[number];

/** The labels stored beside a confirmed booking. */
export type StoredLabel = "checked_in" | "reschedule_pending" | "rescheduled";

export function isSettableLabel(value: unknown): value is SettableLabel {
  return typeof value === "string" && (SETTABLE_LABELS as readonly string[]).includes(value);
}

export interface LabelFacts {
  status: string;
  label: string | null;
  startAt: Date;
  endAt: Date;
}

/** The label a booking shows. */
export function labelOf(booking: Pick<LabelFacts, "status" | "label">): LabelKey {
  switch (booking.status) {
    case "completed":
      return "completed";
    case "no_show":
      return "no_show";
    case "cancelled":
    case "expired":
      return "cancelled";
    default:
      return booking.label === "checked_in" || booking.label === "reschedule_pending" || booking.label === "rescheduled"
        ? booking.label
        : "confirmed";
  }
}

/** A client may arrive a little early: Checked In can be set from an hour before the start. */
export const CHECK_IN_OPENS_MINUTES = 60;

export type LabelBlock =
  /** Cancelled, never paid for, or still being paid for. */
  | "not_active"
  /** Completed and No Show need the appointment to have started; Checked In opens an hour before. */
  | "too_early"
  /** Nothing is left to reschedule once the appointment is over. */
  | "too_late"
  | "unchanged";

export type LabelChange =
  | { ok: true; status: "confirmed" | "completed" | "no_show"; label: StoredLabel | null }
  | { ok: false; reason: LabelBlock };

/** What setting `target` on a booking does, or why it cannot be set now. */
export function labelChange(booking: LabelFacts, target: SettableLabel, now: Date): LabelChange {
  if (!["confirmed", "completed", "no_show"].includes(booking.status)) return { ok: false, reason: "not_active" };
  if (labelOf(booking) === target) return { ok: false, reason: "unchanged" };

  const t = now.getTime();
  switch (target) {
    case "completed":
    case "no_show":
      // A visit marked completed counts towards a free hour, so it has to have begun.
      return t >= booking.startAt.getTime() ? { ok: true, status: target, label: null } : { ok: false, reason: "too_early" };
    case "checked_in":
      return t >= booking.startAt.getTime() - CHECK_IN_OPENS_MINUTES * 60_000
        ? { ok: true, status: "confirmed", label: "checked_in" }
        : { ok: false, reason: "too_early" };
    case "reschedule_pending":
    case "rescheduled":
      return t < booking.endAt.getTime() ? { ok: true, status: "confirmed", label: target } : { ok: false, reason: "too_late" };
    case "confirmed":
      return { ok: true, status: "confirmed", label: null };
  }
}

export const LABEL_BLOCK_TEXT: Record<LabelBlock, string> = {
  not_active: "This booking is cancelled or was never completed, so it has no label.",
  too_early: "Completed and No Show can be set once the appointment has started, and Checked In from an hour before it.",
  too_late: "The appointment is over, so it can no longer be marked for rescheduling.",
  unchanged: "The booking already has that label.",
};
