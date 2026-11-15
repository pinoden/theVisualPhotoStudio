import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { BookingSummary } from "@/components/BookingSummary";
import { StatusBadge } from "@/components/StatusBadge";
import { getDb } from "@/db/client";
import { LABEL_MEANING, LABEL_TEXT } from "@/lib/domain/labels";
import { durationLabel, isIsoDate, longDateLabel, minutesToLabel } from "@/lib/domain/time";
import { getAppointment, moveOptions } from "@/server/appointments";
import { BY_CUSTOMER, BY_SYSTEM } from "@/server/history";
import { requireStaff } from "@/server/session";
import { formatInstant, formatRange, localDateOf } from "@/server/tz";
import { AdminFrame, AdminLoading } from "../../frame";
import { moveBookingAction, setLabelAction } from "../actions";

export const metadata: Metadata = { title: "Appointment", robots: { index: false } };

export default function AppointmentPage(props: PageProps<"/admin/appointments/[ref]">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <AppointmentDetails params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

const WHO: Record<string, string> = { [BY_CUSTOMER]: "The customer", [BY_SYSTEM]: "The site" };

/**
 * One appointment, for both levels of the admin. `getAppointment` decides
 * what this viewer sees: a member of staff gets "not found" for a day that is
 * not theirs, and no contact details or prices unless the owners allow them.
 */
async function AppointmentDetails({
  params,
  searchParams,
}: Pick<PageProps<"/admin/appointments/[ref]">, "params" | "searchParams">) {
  await connection();
  const { ref } = await params;
  const viewer = await requireStaff(`/admin/appointments/${encodeURIComponent(ref)}`);
  const db = await getDb();
  const now = new Date();
  const appointment = await getAppointment(db, viewer, ref, now);
  if (!appointment) notFound();
  const query = await searchParams;
  // "Move to a new time" works in two steps: choose the date, then one of the times that are free on it.
  const moveDate = appointment.may.move && typeof query.move === "string" && isIsoDate(query.move) ? query.move : null;
  const moveTimes = moveDate ? await moveOptions(db, viewer, ref, moveDate, now) : null;

  const when = formatRange(new Date(appointment.startAt), new Date(appointment.endAt));
  const day = localDateOf(new Date(appointment.startAt));

  return (
    <AdminFrame
      active={viewer.role === "owner" ? "/admin/bookings" : "/staff"}
      title={appointment.customerName}
      query={query}
      viewer={viewer}
    >
      <div className="admin-card">
        <h3>
          {when.day} <StatusBadge label={appointment.label} />
        </h3>
        <dl className="detail-list">
          <dt>Time</dt>
          <dd>
            {when.time} ({durationLabel(appointment.durationMinutes)})
          </dd>
          <dt>Studio</dt>
          <dd>{appointment.studios.join(" + ")}</dd>
          {appointment.photography && (
            <>
              <dt>Photography</dt>
              <dd>
                A session with the photographer, who is held for this time as well
                {appointment.photography.includes ? `. ${appointment.photography.includes}` : ""}.
              </dd>
            </>
          )}
          <dt>Client</dt>
          <dd>
            {appointment.customerName}
            {appointment.customerPhone && (
              <>
                {" · "}
                <a href={`tel:${appointment.customerPhone}`}>{appointment.customerPhone}</a>
              </>
            )}
            {appointment.customerEmail && (
              <>
                {" · "}
                <a href={`mailto:${appointment.customerEmail}`}>{appointment.customerEmail}</a>
              </>
            )}
          </dd>
          {appointment.addons.length > 0 && (
            <>
              <dt>Add-ons</dt>
              <dd>
                {appointment.addons
                  .map((addon) => `${addon.name}${addon.quantity > 1 ? ` × ${addon.quantity}` : ""}`)
                  .join(", ")}
              </dd>
            </>
          )}
          {appointment.notes && (
            <>
              <dt>Notes</dt>
              <dd style={{ whiteSpace: "pre-line" }}>{appointment.notes}</dd>
            </>
          )}
          <dt>Reference</dt>
          <dd>{appointment.ref}</dd>
        </dl>
        <p style={{ marginBottom: 0 }}>
          <Link href={`/admin/calendar?view=day&date=${day}`}>This day in the calendar</Link>
          {" · "}
          <Link href={`/staff?date=${day}`}>Day sheet</Link>
          {viewer.role === "owner" && (
            <>
              {" · "}
              <Link href="/admin/bookings">Cancel or refund in Bookings</Link>
            </>
          )}
        </p>
      </div>

      {appointment.may.setLabels && (
        <div className="admin-card">
          <h3>Status label</h3>
          <form action={setLabelAction} className="label-buttons">
            <input type="hidden" name="ref" value={appointment.ref} />
            {appointment.labelChoices.map((choice) => (
              <button
                key={choice.key}
                type="submit"
                name="label"
                value={choice.key}
                className={`btn btn-small ${choice.key === appointment.label ? "btn-dark" : "btn-outline"}`}
                disabled={!choice.allowed}
                aria-pressed={choice.key === appointment.label}
              >
                {LABEL_TEXT[choice.key]}
              </button>
            ))}
          </form>
          <ul className="label-meanings">
            {appointment.labelChoices.map((choice) => (
              <li key={choice.key}>
                <strong>{LABEL_TEXT[choice.key]}:</strong> {LABEL_MEANING[choice.key]}
                {!choice.allowed && choice.key !== appointment.label && <em> {choice.why}</em>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {appointment.may.move && (
        <div className="admin-card" id="move">
          <h3>Move to a new time</h3>
          <form method="get" action={`/admin/appointments/${appointment.ref}#move`} className="admin-form-row">
            <div className="form-group">
              <label className="form-label" htmlFor="move-date">
                New date
              </label>
              <input
                id="move-date"
                type="date"
                name="move"
                className="form-control"
                defaultValue={moveDate ?? day}
                min={localDateOf(now)}
                required
              />
            </div>
            <button type="submit" className="btn btn-outline btn-small">
              Show free times
            </button>
          </form>
          {moveDate && moveTimes && !moveTimes.ok && <p className="field-error">{moveTimes.message}</p>}
          {moveDate && moveTimes?.ok && moveTimes.starts.length === 0 && (
            <p className="field-error">
              No time is free on {longDateLabel(moveDate)} for {durationLabel(appointment.durationMinutes)} in{" "}
              {appointment.studios.join(" + ")}.
            </p>
          )}
          {moveDate && moveTimes?.ok && moveTimes.starts.length > 0 && (
            <form action={moveBookingAction}>
              <input type="hidden" name="ref" value={appointment.ref} />
              <input type="hidden" name="date" value={moveDate} />
              <div className="admin-form-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="move-time">
                    Free start times on {longDateLabel(moveDate)}
                  </label>
                  <select id="move-time" name="startMinute" className="form-control" required>
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
              <label style={{ display: "block", fontSize: ".85rem" }}>
                <input type="checkbox" name="countsAsClientMove" defaultChecked /> The client asked for this move. It
                counts as their one reschedule: the booking is then no longer refunded automatically, as the rental
                terms say. Untick it when the studio needs the change.
              </label>
            </form>
          )}
          <p style={{ fontSize: ".78rem", margin: ".75rem 0 0" }}>
            The studio and the length stay the same, and what was paid stays as it is. Only times that are free are
            offered: inside opening hours, and at least 15 minutes from any other appointment in the studio. The client
            is emailed the new time.
          </p>
        </div>
      )}

      {appointment.money && (
        <div className="admin-card">
          <h3>Price</h3>
          <BookingSummary booking={appointment.money} />
        </div>
      )}

      <div className="admin-card">
        <h3>History</h3>
        {appointment.history.length === 0 ? (
          <p style={{ marginBottom: 0 }}>No changes have been recorded for this booking.</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table history-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Change</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {appointment.history.map((event, index) => (
                  <tr key={index}>
                    <td style={{ whiteSpace: "nowrap" }}>{formatInstant(new Date(event.at))}</td>
                    <td>
                      {event.from === "new" ? "Booked" : `${LABEL_TEXT[event.from]} → ${LABEL_TEXT[event.to]}`}
                      {event.note && <div style={{ fontSize: ".8rem" }}>{event.note}</div>}
                    </td>
                    <td>{WHO[event.actor] ?? event.actor}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdminFrame>
  );
}
