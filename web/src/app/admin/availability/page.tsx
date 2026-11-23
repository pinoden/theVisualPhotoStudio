import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense, type CSSProperties } from "react";
import { getDb } from "@/db/client";
import { can } from "@/lib/abilities";
import { shortStudioName } from "@/lib/domain/appointment-look";
import { monthTitle, shiftMonth, weeksOf } from "@/lib/domain/months";
import { longDateLabel, minutesToHHMM, type IsoDate } from "@/lib/domain/time";
import { BLOCK_REASONS, blockTimeText, listBlockSeries, planOf, type BlockSeries } from "@/server/blocked-time";
import { loadCatalog, type CatalogStudio } from "@/server/catalog";
import { requireManager } from "@/server/session";
import { localDateOf } from "@/server/tz";
import { createBlocksAction, removeBlocksAction, updateBlocksAction } from "../actions";
import { AdminFrame, AdminLoading } from "../frame";

export const metadata: Metadata = { title: "Availability & Blocked Time", robots: { index: false } };

export default function AvailabilityPage(props: PageProps<"/admin/availability">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Availability searchParams={props.searchParams} />
    </Suspense>
  );
}

const WEEKDAYS: [number, string, string][] = [
  [1, "Mon", "Monday"],
  [2, "Tue", "Tuesday"],
  [3, "Wed", "Wednesday"],
  [4, "Thu", "Thursday"],
  [5, "Fri", "Friday"],
  [6, "Sat", "Saturday"],
  [7, "Sun", "Sunday"],
];

/** "All studios", or their short names: "Paris, Blanche". */
function studiosText(series: BlockSeries, all: CatalogStudio[]): string {
  return all.length > 1 && all.every((studio) => series.studioIds.includes(studio.id)) ? "All studios" : series.studios.map(shortStudioName).join(", ");
}

/** "December 24 – 26, 2026", "Mondays, November 16 – December 14, 2026", or one day. */
function daysText(series: BlockSeries): string {
  const plan = planOf(series);
  const first = longDateLabel(plan.from).replace(/^\w+, /, "");
  const last = longDateLabel(plan.to).replace(/^\w+, /, "");
  const span = plan.from === plan.to ? longDateLabel(plan.from) : `${first} – ${last}`;
  if (plan.weekdays.length === 0) return span;
  const names = WEEKDAYS.filter(([day]) => plan.weekdays.includes(day)).map(([, , long]) => `${long}s`);
  return `${names.join(", ")}, ${span}`;
}

/**
 * Availability & Blocked Time (the owner's admin brief of 2026-11-22, item 12): a calendar of its own for the time
 * taken off what clients can book, apart from the appointments, with the form to block a time, a whole day, several
 * days or every week, in one studio, several or all of them, and the blocks still to come, to change or remove.
 */
async function Availability({ searchParams }: Pick<PageProps<"/admin/availability">, "searchParams">) {
  await connection();
  const viewer = await requireManager("/admin/availability");
  const db = await getDb();
  const now = new Date();
  const catalog = await loadCatalog(db);
  if (!can(viewer, "blockTime", catalog.settings)) notFound();
  const query = await searchParams;
  const today = localDateOf(now);
  const month = typeof query.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(query.month) ? query.month : today.slice(0, 7);
  const series = await listBlockSeries(db, now);
  const editing = typeof query.edit === "string" ? (series.find((item) => item.key === query.edit) ?? null) : null;
  const plan = editing ? planOf(editing) : null;

  // The month's blocks, day by day.
  const byDay = new Map<IsoDate, { series: BlockSeries; time: string }[]>();
  for (const item of series) {
    for (const day of item.days) {
      if (!day.date.startsWith(month)) continue;
      byDay.set(day.date, [...(byDay.get(day.date) ?? []), { series: item, time: blockTimeText(day) }]);
    }
  }

  return (
    <AdminFrame active="/admin/availability" title="Availability & Blocked Time" query={query} viewer={viewer} settings={catalog.settings}>
      {/* Drawn afresh for each block changed: a form already on screen keeps what its fields held, not their new defaults. */}
      <form action={editing ? updateBlocksAction : createBlocksAction} className="admin-card avail-form" id="block-form" key={`block-${editing?.key ?? "new"}`}>
        <h3>{editing ? "Change this block" : "Block time"}</h3>
        <p style={{ fontSize: ".875rem" }}>
          Clients cannot book a blocked time, in any studio it covers, bundles and photography sessions included. A
          block cannot cover an appointment: move or cancel the appointment first, and the block says which ones.
        </p>
        {editing && <input type="hidden" name="key" value={editing.key} />}
        <fieldset className="admin-fieldset">
          <legend className="form-label">Studios</legend>
          <label className="avail-check avail-all">
            <input type="checkbox" name="allStudios" value="1" defaultChecked={plan ? catalog.studios.every((studio) => plan.studioIds.includes(studio.id)) : false} /> Select All Studios
          </label>
          {catalog.studios.map((studio) => (
            <label key={studio.id} className="avail-check" style={{ "--studio": studio.color } as CSSProperties}>
              <input type="checkbox" name="studio" value={studio.id} defaultChecked={plan?.studioIds.includes(studio.id) ?? false} />{" "}
              <span className="cal-swatch" aria-hidden="true" /> {studio.name}
            </label>
          ))}
        </fieldset>
        <div className="admin-form-row">
          <div className="form-group">
            <label className="form-label" htmlFor="block-from">
              First day
            </label>
            <input id="block-from" name="from" type="date" className="form-control" min={today} defaultValue={plan?.from ?? ""} required />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="block-to">
              Last day
            </label>
            <input id="block-to" name="to" type="date" className="form-control" min={today} defaultValue={plan && plan.to !== plan.from ? plan.to : ""} />
          </div>
        </div>
        <p className="avail-hint">Leave the last day empty to block one day.</p>
        <label className="avail-check">
          <input type="checkbox" name="wholeDay" value="1" defaultChecked={plan?.wholeDay ?? false} /> Block Entire Day
        </label>
        <div className="admin-form-row">
          <div className="form-group">
            <label className="form-label" htmlFor="block-start">
              Start
            </label>
            <input id="block-start" name="start" type="time" className="form-control" defaultValue={plan && !plan.wholeDay ? minutesToHHMM(plan.startMinute) : "09:00"} />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="block-end">
              End
            </label>
            <input id="block-end" name="end" type="time" className="form-control" defaultValue={plan && !plan.wholeDay ? minutesToHHMM(plan.endMinute) : "19:00"} />
          </div>
        </div>
        <p className="avail-hint">The start and end are left out of a day blocked entirely.</p>
        <fieldset className="admin-fieldset">
          <legend className="form-label">Repeat every week, only on</legend>
          {WEEKDAYS.map(([day, short, long]) => (
            <label key={day} className="avail-check">
              <input type="checkbox" name="weekday" value={day} defaultChecked={plan?.weekdays.includes(day) ?? false} /> <abbr title={long}>{short}</abbr>
            </label>
          ))}
          <p className="avail-hint">None ticked: every day from the first day to the last.</p>
        </fieldset>
        <div className="admin-form-row">
          <div className="form-group">
            <label className="form-label" htmlFor="block-reason">
              Reason
            </label>
            <select id="block-reason" name="reason" className="form-control" defaultValue={plan?.reason ?? ""}>
              <option value="">None given</option>
              {Object.entries(BLOCK_REASONS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ flex: "2 1 14rem" }}>
            <label className="form-label" htmlFor="block-note">
              Note
            </label>
            <input id="block-note" name="note" className="form-control" maxLength={200} defaultValue={plan?.note ?? ""} />
          </div>
        </div>
        <div className="avail-actions">
          <button type="submit" className="btn btn-dark btn-small">
            {editing ? "Save changes" : "Block"}
          </button>
          {editing && (
            <Link href={`/admin/availability?month=${month}`} className="btn btn-outline btn-small">
              Cancel
            </Link>
          )}
        </div>
      </form>

      <div className="admin-card">
        <div className="cal-nav avail-month-nav">
          <Link href={`/admin/availability?month=${shiftMonth(month, -1)}`} className="btn btn-outline btn-small" aria-label="Previous month">
            ←
          </Link>
          <Link href={`/admin/availability?month=${today.slice(0, 7)}`} className="btn btn-outline btn-small">
            This month
          </Link>
          <Link href={`/admin/availability?month=${shiftMonth(month, 1)}`} className="btn btn-outline btn-small" aria-label="Next month">
            →
          </Link>
          <h3 className="cal-title">{monthTitle(month)}</h3>
        </div>
        <div className="cal-month-wrap">
          <table className="cal-month avail-month">
            <thead>
              <tr>
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((name) => (
                  <th key={name} scope="col">
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeksOf(month).map((week, index) => (
                <tr key={index}>
                  {week.map((day, column) => (
                    <td key={day ?? `empty-${column}`} className={[day === null ? "outside" : "", day === today ? "today" : ""].join(" ").trim() || undefined}>
                      {day && (
                        <>
                          <Link href={`/admin/calendar?view=day&date=${day}`} className="cal-daynum" aria-label={longDateLabel(day)}>
                            {Number(day.slice(8))}
                          </Link>
                          {(byDay.get(day) ?? []).map(({ series: item, time }) => {
                            const said = `${studiosText(item, catalog.studios)} · ${time}${item.reason ? ` · ${BLOCK_REASONS[item.reason]}` : ""}`;
                            return (
                              <Link key={item.key} href={`/admin/availability?month=${month}&edit=${item.key}#block-form`} className="avail-chip" title={said}>
                                {said}
                              </Link>
                            );
                          })}
                        </>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="admin-card" id="blocks">
        <h3>Blocked from now on</h3>
        {series.length === 0 ? (
          <p>Nothing is blocked.</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Days</th>
                  <th>Time</th>
                  <th>Studios</th>
                  <th>Reason</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {series.map((item) => (
                  <tr key={item.key}>
                    <td>
                      {daysText(item)}
                      {item.days.length > 1 && <span className="avail-hint"> ({item.days.length} days)</span>}
                    </td>
                    <td>{blockTimeText(item.days[0])}</td>
                    <td>{studiosText(item, catalog.studios)}</td>
                    <td>
                      {item.reason ? BLOCK_REASONS[item.reason] : ""}
                      {item.note && (item.reason ? `: ${item.note}` : item.note)}
                    </td>
                    <td className="avail-row-actions">
                      <Link href={`/admin/availability?month=${item.days[0].date.slice(0, 7)}&edit=${item.key}#block-form`} className="btn btn-outline btn-small">
                        Edit
                      </Link>
                      <form action={removeBlocksAction}>
                        <input type="hidden" name="key" value={item.key} />
                        <input type="hidden" name="month" value={month} />
                        <button type="submit" className="btn btn-outline btn-small">
                          Remove
                        </button>
                      </form>
                    </td>
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
