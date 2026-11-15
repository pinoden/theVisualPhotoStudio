import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { isIsoDate, longDateLabel } from "@/lib/domain/time";
import { requireStaff } from "@/server/session";
import { getDaySheet, listShiftDays } from "@/server/staff";
import { localDateOf } from "@/server/tz";
import { attendanceAction } from "./actions";

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

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  confirmed: { label: "Expected", className: "badge badge-pending" },
  completed: { label: "Came", className: "badge badge-confirmed" },
  no_show: { label: "No-show", className: "badge badge-cancelled" },
};

async function DaySheet({ searchParams }: Pick<PageProps<"/staff">, "searchParams">) {
  await connection();
  const viewer = await requireStaff("/staff");
  const db = await getDb();
  const query = await searchParams;
  const now = new Date();
  const today = localDateOf(now);
  const isOwner = viewer.role === "owner";

  // Staff may only open days assigned to them; the owner may open any day.
  const shiftDays = isOwner ? [] : await listShiftDays(db, viewer.id, today);
  const requested = typeof query.date === "string" && isIsoDate(query.date) ? query.date : null;
  const date = requested ?? (isOwner || shiftDays.includes(today) ? today : (shiftDays[0] ?? null));
  const error = typeof query.error === "string" ? query.error : "";

  const dayPicker = isOwner ? (
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
                const badge = STATUS_BADGE[entry.status];
                const started = new Date(entry.startAt) <= now;
                return (
                  <tr key={entry.ref}>
                    <td style={{ whiteSpace: "nowrap" }}>{entry.time}</td>
                    <td>{entry.studios.join(" + ")}</td>
                    <td>
                      <strong style={{ color: "var(--color-dark)" }}>{entry.customerName}</strong>
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
                      {entry.addons.map((addon) => (
                        <div key={addon.name}>
                          {addon.name}
                          {addon.quantity > 1 ? ` × ${addon.quantity}` : ""}
                        </div>
                      ))}
                      {entry.notes && <div style={{ fontStyle: "italic" }}>{entry.notes}</div>}
                    </td>
                    <td>
                      <span className={badge.className}>{badge.label}</span>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {started ? (
                        <form action={attendanceAction} style={{ display: "flex", gap: ".4rem" }}>
                          <input type="hidden" name="ref" value={entry.ref} />
                          <input type="hidden" name="date" value={date} />
                          {entry.status !== "completed" && (
                            <button type="submit" name="status" value="completed" className="btn btn-dark btn-small">
                              Came
                            </button>
                          )}
                          {entry.status !== "no_show" && (
                            <button type="submit" name="status" value="no_show" className="btn btn-outline btn-small">
                              No-show
                            </button>
                          )}
                        </form>
                      ) : (
                        <span style={{ fontSize: ".8rem" }}>Not started</span>
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
