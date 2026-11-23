import { formatCents } from "@/lib/domain/pricing";
import { durationLabel, longDateLabel, minutesToLabel } from "@/lib/domain/time";
import type { Appointment, MovePricePreview, moveOptions } from "@/server/appointments";
import { PRICED_AS } from "@/server/reprice";
import { localDateOf } from "@/server/tz";
import { moveBookingAction } from "./actions";

/** What moving the booking to `date` does to its price (follow-up 5), in a sentence: its amounts only for a viewer who sees prices. */
function movePriceSentence(price: MovePricePreview, date: string, seesPrices: boolean): string {
  const day = `${longDateLabel(date)} is priced as ${PRICED_AS[price.dayType]}`;
  if (!seesPrices) return `${day}, so the booking’s price changes with the move. The client is emailed the new price.`;
  return [
    `${day}: the booking’s total becomes ${formatCents(price.nowCents)} instead of ${formatCents(price.wasCents)}.`,
    ...(price.codeBackCents > 0 ? [`${formatCents(price.codeBackCents)} of the credit it was paid with goes back on its code.`] : []),
    ...(price.owedCents > 0 ? [`The client will then owe ${formatCents(price.owedCents)}.`] : []),
    ...(price.creditLeftCents > 0 ? [`The client will then have paid ${formatCents(price.creditLeftCents)} more than its price: it is theirs, to refund.`] : []),
    "The client is emailed the new price.",
  ].join(" ");
}

/**
 * "Move to a new time", in two steps: the date (a form that reloads the page with `?move=<date>`), then one of the
 * times free on it. On the appointment's page and in the calendar's pop-up (the owner's admin brief of 2026-11-22,
 * item 5), which differ only in where the date's form goes and where the move comes back to. Shown to a viewer who may
 * move bookings (`appointment.may.move`).
 */
export function MoveToNewTime({
  appointment,
  moveDate,
  moveTimes,
  dateForm,
  back,
  today,
  idPrefix,
  owner = false,
  afterHours = false,
}: {
  appointment: Appointment;
  /** The date whose free times are shown, or null before one is chosen. */
  moveDate: string | null;
  moveTimes: Awaited<ReturnType<typeof moveOptions>> | null;
  /** Where "Show free times" goes, and the page's own fields it keeps (the calendar's view and day). */
  dateForm: { action: string; keep: Record<string, string> };
  /** A calendar address the move comes back to, or null for the appointment's page. */
  back: string | null;
  today: string;
  /** Makes the fields' ids its own, as the calendar's pop-up and a page could share them. */
  idPrefix: string;
  /** An owner, who may pass over the opening hours (question 76), and whether the times shown do. */
  owner?: boolean;
  afterHours?: boolean;
}) {
  if (appointment.moveBlocked) return <p className="move-blocked">{appointment.moveBlocked}</p>;
  const day = localDateOf(new Date(appointment.startAt));
  return (
    <>
      <form method="get" action={dateForm.action} className="admin-form-row">
        {Object.entries(dateForm.keep).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <div className="form-group">
          <label className="form-label" htmlFor={`${idPrefix}-date`}>
            New date
          </label>
          <input id={`${idPrefix}-date`} type="date" name="move" className="form-control" defaultValue={moveDate ?? day} min={today} required />
        </div>
        <button type="submit" className="btn btn-outline btn-small">
          Show free times
        </button>
        {owner && (
          <label className="admin-check" style={{ display: "block", fontSize: ".85rem", flexBasis: "100%" }}>
            <input type="checkbox" name="afterHours" value="1" defaultChecked={afterHours} /> Outside the opening hours (owners only). Other bookings,
            the gap after each and blocked time still stand.
          </label>
        )}
      </form>
      {moveDate && moveTimes && !moveTimes.ok && <p className="field-error">{moveTimes.message}</p>}
      {moveDate && moveTimes?.ok && moveTimes.starts.length === 0 && (
        <p className="field-error">
          No time is free on {longDateLabel(moveDate)} for {durationLabel(appointment.durationMinutes)} in {appointment.studios.join(" + ")}.
        </p>
      )}
      {moveDate && moveTimes?.ok && moveTimes.starts.length > 0 && moveTimes.price && (
        <p className="move-price" role="status">
          {movePriceSentence(moveTimes.price, moveDate, appointment.money !== null)}
        </p>
      )}
      {moveDate && moveTimes?.ok && moveTimes.starts.length > 0 && (
        <form action={moveBookingAction}>
          <input type="hidden" name="ref" value={appointment.ref} />
          <input type="hidden" name="date" value={moveDate} />
          {back && <input type="hidden" name="back" value={back} />}
          {owner && afterHours && <input type="hidden" name="afterHours" value="1" />}
          <div className="admin-form-row">
            <div className="form-group">
              <label className="form-label" htmlFor={`${idPrefix}-time`}>
                Free start times on {longDateLabel(moveDate)}
              </label>
              <select id={`${idPrefix}-time`} name="startMinute" className="form-control" required>
                {moveTimes.starts.map((minute) => (
                  <option key={minute} value={minute}>
                    {minutesToLabel(minute)} – {minutesToLabel(minute + appointment.durationMinutes)}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn btn-dark btn-small">
              Move booking
            </button>
          </div>
          {appointment.terms.maxReschedules > 0 ? (
            <label style={{ display: "block", fontSize: ".85rem" }}>
              <input type="checkbox" name="countsAsClientMove" defaultChecked /> The client asked for this move. It counts as a reschedule of
              theirs: the booking is then no longer refunded automatically, as the rental terms say
              {appointment.terms.rescheduleFeeCents > 0
                ? `, and each move beyond their ${appointment.terms.maxReschedules === 1 ? "free one" : `${appointment.terms.maxReschedules} free ones`} costs them ${formatCents(appointment.terms.rescheduleFeeCents)} online`
                : ""}
              . Untick it when the studio needs the change.
            </label>
          ) : (
            <p style={{ fontSize: ".85rem", margin: 0 }}>
              Moving is switched off under Settings, so the rental terms say nothing about it: the move does not count against the client, and
              the booking keeps its refund.
            </p>
          )}
        </form>
      )}
      <p style={{ fontSize: ".78rem", margin: ".75rem 0 0" }}>
        The studio and the length stay the same. Moved to a day of the other kind (a weekday or a weekend), the booking takes that day&rsquo;s
        price, from today&rsquo;s prices: the client then owes the difference, or has paid more than its price, which the studio refunds. Only times
        that are free are offered: inside opening hours, and at least 15 minutes from any other appointment in the studio. The client is emailed
        the new time.
      </p>
    </>
  );
}
