import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { BookingSummary } from "@/components/BookingSummary";
import { StatusBadge } from "@/components/StatusBadge";
import { getDb } from "@/db/client";
import { LABEL_MEANING, LABEL_TEXT } from "@/lib/domain/labels";
import { durationLabel } from "@/lib/domain/time";
import { getAppointment } from "@/server/appointments";
import { BY_CUSTOMER, BY_SYSTEM } from "@/server/history";
import { requireStaff } from "@/server/session";
import { formatInstant, formatRange, localDateOf } from "@/server/tz";
import { AdminFrame, AdminLoading } from "../../frame";
import { setLabelAction } from "../actions";

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
  const appointment = await getAppointment(await getDb(), viewer, ref, new Date());
  if (!appointment) notFound();

  const when = formatRange(new Date(appointment.startAt), new Date(appointment.endAt));
  const day = localDateOf(new Date(appointment.startAt));

  return (
    <AdminFrame
      active={viewer.role === "owner" ? "/admin/bookings" : "/staff"}
      title={appointment.customerName}
      query={await searchParams}
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
          <Link href={`/staff?date=${day}`}>Day sheet for this day</Link>
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
            <table className="data-table">
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
