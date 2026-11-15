import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { getDb } from "@/db/client";
import { LABEL_TEXT, SETTABLE_LABELS } from "@/lib/domain/labels";
import { isIsoDate, longDateLabel } from "@/lib/domain/time";
import { can } from "@/lib/staff-abilities";
import { requireStaff } from "@/server/session";
import { loadSettings } from "@/server/settings";
import { getDaySheet, listShiftDays } from "@/server/staff";
import { localDateOf } from "@/server/tz";
import { setLabelAction } from "../admin/appointments/actions";

export const metadata: Metadata = { title: "Day Sheet", robots: { index: false } };

export default function StaffPage(props: PageProps<"/staff">) {
  return (
    <>
      <div className="page-banner">
        <p className="section-eyebrow">Staff</p>
        <h1>Day Sheet</h1>
      </div>
      <section className="section section-cream">
        <div className="container">
          <Suspense fallback={<div className="spinner" />}>
            <DaySheet searchParams={props.searchParams} />
          </Suspense>
        </div>
      </section>
    </>
  );
}

async function DaySheet({ searchParams }: Pick<PageProps<"/staff">, "searchParams">) {
  await connection();
  const viewer = await requireStaff("/staff");
  const db = await getDb();
  const query = await searchParams;
  const now = new Date();
  const today = localDateOf(now);
  const settings = await loadSettings(db);
  // The owners open any day. Staff open the days assigned to them, or any day when the owners allow it.
  const anyDay = viewer.role === "owner" || settings.staffSeesAllDays;
  const mayLabel = can(viewer, "staffSetsLabels", settings);

  const shiftDays = anyDay ? [] : await listShiftDays(db, viewer.id, today);
  const requested = typeof query.date === "string" && isIsoDate(query.date) ? query.date : null;
  const date = requested ?? (anyDay || shiftDays.includes(today) ? today : (shiftDays[0] ?? null));
  const error = typeof query.error === "string" ? query.error : "";
  const notice = typeof query.notice === "string" ? query.notice : "";

  const dayPicker = anyDay ? (
    <form method="get" className="admin-form-row">
      <div className="form-group">
        <label className="form-label" htmlFor="staff-date">
          Date
        </label>
        <input id="staff-date" type="date" name="date" className="form-control" defaultValue={date ?? today} />
      </div>
      <button type="submit" className="btn btn-dark btn-small">
        Show
      </button>
    </form>
  ) : (
    <p>
      Your days:{" "}
      {shiftDays.length === 0
        ? "none assigned yet."
        : shiftDays.map((day) => (
            <Link key={day} href={`/staff?date=${day}`} className="chip" style={day === date ? { borderColor: "var(--color-rose)" } : undefined}>
              {day === today ? "Today" : longDateLabel(day)}
            </Link>
          ))}
    </p>
  );

  if (!date) {
    return (
      <>
        {dayPicker}
        <div className="notice">No days are assigned to you yet. The owner assigns the days you can see.</div>
      </>
    );
  }

  const sheet = await getDaySheet(db, viewer, date);
  if (!sheet.ok) {
    return (
      <>
        {dayPicker}
        <div className="flash flash-error" role="alert">
          {sheet.reason === "forbidden" ? `${longDateLabel(date)} is not assigned to you.` : "That date is not valid."}
        </div>
      </>
    );
  }

  return (
    <>
      {dayPicker}
      {notice && (
        <div className="flash flash-success" role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className="flash flash-error" role="alert">
          {error}
        </div>
      )}
      <h2 style={{ fontSize: "1.6rem" }}>{longDateLabel(date)}</h2>
      {sheet.entries.length === 0 ? (
        <div className="notice">No bookings on this day.</div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Studio</th>
                <th>Customer</th>
                <th>Extras and notes</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sheet.entries.map((entry) => {
                return (
                  <tr key={entry.ref}>
                    <td style={{ whiteSpace: "nowrap" }}>{entry.time}</td>
                    <td>{entry.studios.join(" + ")}</td>
                    <td>
                      <Link href={`/admin/appointments/${entry.ref}`}>
                        <strong>{entry.customerName}</strong>
                      </Link>
                      <br />
                      <span style={{ fontSize: ".8rem" }}>{entry.ref}</span>
                      {entry.customerPhone && (
                        <>
                          <br />
                          <a href={`tel:${entry.customerPhone}`}>{entry.customerPhone}</a>
                        </>
                      )}
                      {entry.customerEmail && (
                        <>
                          <br />
                          {entry.customerEmail}
                        </>
                      )}
                    </td>
                    <td>
                      {entry.addons.map((addon, index) => (
                        <div key={index}>
                          {addon.name}
                          {addon.quantity > 1 ? ` × ${addon.quantity}` : ""}
                        </div>
                      ))}
                      {entry.photography && <div>Photography session</div>}
                      {entry.notes && <div style={{ fontStyle: "italic" }}>{entry.notes}</div>}
                    </td>
                    <td>
                      <StatusBadge label={entry.label} />
                    </td>
                    <td>
                      {mayLabel && (
                        <form action={setLabelAction} className="label-select">
                          <input type="hidden" name="ref" value={entry.ref} />
                          <input type="hidden" name="back" value={`/staff?date=${date}`} />
                          <select
                            name="label"
                            className="form-control"
                            defaultValue={entry.label}
                            aria-label={`Status label for ${entry.customerName}`}
                          >
                            {SETTABLE_LABELS.map((label) => (
                              <option key={label} value={label}>
                                {LABEL_TEXT[label]}
                              </option>
                            ))}
                          </select>
                          <button type="submit" className="btn btn-dark btn-small">
                            Set
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
