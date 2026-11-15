import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense, type CSSProperties } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { getDb } from "@/db/client";
import {
  BUFFER_SHOWN_MINUTES,
  CALENDAR_VIEWS,
  isCalendarView,
  monthLabel,
  monthWeeks,
  rangeOf,
  shiftDate,
  shortDayLabel,
  weekDays,
  weekLabel,
  type CalendarView,
} from "@/lib/domain/calendar";
import { LABEL_TEXT } from "@/lib/domain/labels";
import { isIsoDate, isoWeekday, longDateLabel, minutesToLabel, type IsoDate } from "@/lib/domain/time";
import { can } from "@/lib/staff-abilities";
import { loadCalendar, type CalendarAppointment, type CalendarBlock } from "@/server/calendar";
import { loadCatalog, type CatalogStudio } from "@/server/catalog";
import { requireStaff } from "@/server/session";
import { localDateOf } from "@/server/tz";
import { AdminFrame, AdminLoading } from "../frame";

export const metadata: Metadata = { title: "Calendar", robots: { index: false } };

export default function CalendarPage(props: PageProps<"/admin/calendar">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Calendar searchParams={props.searchParams} />
    </Suspense>
  );
}

const VIEW_NAME: Record<CalendarView, string> = { month: "Month", week: "Week", day: "Day" };
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** How many appointments a day of the month view lists before "+2 more". */
const MONTH_CELL_LIMIT = 4;

/** Custom properties for a block on the time grid: where it starts, how long it is, and its studio's colour. */
const place = (top: number, length: number, color?: string) =>
  ({ "--top": top, "--len": length, ...(color ? { "--studio": color } : {}) }) as CSSProperties;

/** One appointment in one studio: what a calendar draws. */
interface Entry extends CalendarAppointment {
  studio: CatalogStudio;
}

/**
 * The admin calendar, for both levels of the admin. Every control is a link
 * or a form that reloads the page with a new address, so there is nothing
 * here that does not work without scripts, and a view can be bookmarked.
 */
async function Calendar({ searchParams }: Pick<PageProps<"/admin/calendar">, "searchParams">) {
  await connection();
  const viewer = await requireStaff("/admin/calendar");
  const query = await searchParams;
  const db = await getDb();
  const today = localDateOf(new Date());

  const view: CalendarView = isCalendarView(query.view) ? query.view : "week";
  const date = typeof query.date === "string" && isIsoDate(query.date) ? query.date : today;
  const catalog = await loadCatalog(db);
  const chosen = catalog.studios.find((studio) => studio.slug === query.studio);
  const studios = chosen ? [chosen] : catalog.studios;

  const span = rangeOf(view, date);
  const data = await loadCalendar(db, viewer, catalog, span);
  const visible = new Set(data.days);

  // One entry for each studio an appointment holds, in the studios being shown.
  const entries: Entry[] = data.appointments.flatMap((appointment) =>
    studios.filter((studio) => appointment.studioIds.includes(studio.id)).map((studio) => ({ ...appointment, studio })),
  );
  const blocks = data.blocks.filter((block) => studios.some((studio) => studio.id === block.studioId));

  const href = (to: { view?: CalendarView; date?: IsoDate; studio?: string | null }) => {
    const studio = to.studio === undefined ? (chosen?.slug ?? null) : to.studio;
    return `/admin/calendar?view=${to.view ?? view}&date=${to.date ?? date}${studio ? `&studio=${studio}` : ""}`;
  };
  const title = view === "month" ? monthLabel(date) : view === "week" ? weekLabel(date) : longDateLabel(date);
  const mayBook = can(viewer, "staffCreatesBookings", catalog.settings);

  return (
    <AdminFrame active="/admin/calendar" title="Calendar" query={query} viewer={viewer} settings={catalog.settings}>
      <div className="cal-toolbar">
        <div className="cal-nav">
          <Link href={href({ date: shiftDate(view, date, -1) })} className="btn btn-outline btn-small" aria-label={`Previous ${view}`}>
            ←
          </Link>
          <Link href={href({ date: today })} className="btn btn-outline btn-small">
            Today
          </Link>
          <Link href={href({ date: shiftDate(view, date, 1) })} className="btn btn-outline btn-small" aria-label={`Next ${view}`}>
            →
          </Link>
          <h2 className="cal-title">{title}</h2>
        </div>
        <form method="get" className="cal-jump">
          <input type="hidden" name="view" value={view} />
          {chosen && <input type="hidden" name="studio" value={chosen.slug} />}
          <label className="visually-hidden" htmlFor="cal-date">
            Go to date
          </label>
          <input id="cal-date" type="date" name="date" className="form-control" defaultValue={date} />
          <button type="submit" className="btn btn-dark btn-small">
            Go
          </button>
        </form>
      </div>

      <div className="cal-toolbar">
        <nav className="cal-tabs" aria-label="Calendar view">
          {CALENDAR_VIEWS.map((name) => (
            <Link key={name} href={href({ view: name })} aria-current={name === view ? "page" : undefined}>
              {VIEW_NAME[name]}
            </Link>
          ))}
        </nav>
        <nav className="cal-filter" aria-label="Studio">
          <Link href={href({ studio: null })} aria-current={chosen ? undefined : "true"} className="cal-studio">
            All studios
          </Link>
          {catalog.studios.map((studio) => (
            <Link
              key={studio.id}
              href={href({ studio: studio.slug })}
              aria-current={chosen?.id === studio.id ? "true" : undefined}
              className="cal-studio"
              style={{ "--studio": studio.color } as CSSProperties}
            >
              <span className="cal-swatch" aria-hidden="true" />
              {studio.name}
            </Link>
          ))}
        </nav>
        {mayBook && (
          <Link href={`/admin/calendar/new?date=${date}${chosen ? `&studio=${chosen.id}` : ""}`} className="btn btn-dark btn-small">
            New booking
          </Link>
        )}
      </div>

      {data.days.length === 0 && (
        <div className="notice">None of these days is assigned to you. The owners assign the days you can see.</div>
      )}

      {view === "month" && <Month date={date} today={today} entries={entries} visible={visible} dayHref={(day) => href({ view: "day", date: day })} />}
      {view === "week" && (
        <Week date={date} today={today} entries={entries} blocks={blocks} studios={studios} visible={visible} dayHref={(day) => href({ view: "day", date: day })} />
      )}
      {view === "day" && <Day date={date} entries={entries} blocks={blocks} studios={studios} visible={visible.has(date)} />}

      {view !== "month" && (
        <p className="cal-legend">
          <span className="cal-legend-buffer" aria-hidden="true" /> The {BUFFER_SHOWN_MINUTES} minutes kept free before and after
          each appointment.
          <span className="cal-legend-block" aria-hidden="true" /> Time the studio blocked.
        </p>
      )}
    </AdminFrame>
  );
}

// ── Month ────────────────────────────────────────────────────────────────────

function Month({
  date,
  today,
  entries,
  visible,
  dayHref,
}: {
  date: IsoDate;
  today: IsoDate;
  entries: Entry[];
  visible: Set<IsoDate>;
  dayHref: (day: IsoDate) => string;
}) {
  const month = date.slice(0, 7);
  return (
    <div className="cal-month-wrap">
      <table className="cal-month">
        <thead>
          <tr>
            {WEEKDAYS.map((name) => (
              <th key={name} scope="col">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {monthWeeks(date).map((week) => (
            <tr key={week[0]}>
              {week.map((day) => {
                const ofDay = entries.filter((entry) => entry.date === day);
                const more = ofDay.length - MONTH_CELL_LIMIT;
                return (
                  <td
                    key={day}
                    className={[day.startsWith(month) ? "" : "outside", day === today ? "today" : "", visible.has(day) ? "" : "unseen"].join(" ").trim()}
                  >
                    <Link href={dayHref(day)} className="cal-daynum" aria-label={longDateLabel(day)}>
                      {Number(day.slice(8))}
                    </Link>
                    {ofDay.slice(0, MONTH_CELL_LIMIT).map((entry) => (
                      <AppointmentChip key={`${entry.ref}-${entry.studio.id}`} entry={entry} />
                    ))}
                    {more > 0 && (
                      <Link href={dayHref(day)} className="cal-more">
                        +{more} more
                      </Link>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "10a", "12:15p": a time for where there is room for little. The full time is in the title and on the appointment. */
const shortTime = (minute: number) => minutesToLabel(minute).replace(":00", "").replace(" AM", "a").replace(" PM", "p");

const describe = (entry: Entry) =>
  `${minutesToLabel(entry.startMinute)} – ${minutesToLabel(entry.endMinute)}, ${entry.customerName}, ${entry.studio.name}, ${LABEL_TEXT[entry.label]}${entry.photography ? ", photography session" : ""}`;

/** An appointment as one line: its time and the client's name, in its studio's colour, with a dot for its status. */
function AppointmentChip({ entry }: { entry: Entry }) {
  return (
    <Link
      href={`/admin/appointments/${entry.ref}`}
      className="cal-chip"
      style={{ "--studio": entry.studio.color } as CSSProperties}
      title={describe(entry)}
      aria-label={describe(entry)}
    >
      <span className={`cal-dot status-${entry.label}`} aria-hidden="true" />
      <span className="cal-chip-text">
        {shortTime(entry.startMinute)} {entry.customerName}
      </span>
    </Link>
  );
}

// ── The time grid shared by the week and the day ─────────────────────────────

/** The part of the day a grid shows: from the earliest opening to the latest closing, and whatever lies outside them. */
function gridHours(days: IsoDate[], studios: CatalogStudio[], entries: Entry[], blocks: CalendarBlock[]): { start: number; end: number } {
  let start = 24 * 60;
  let end = 0;
  for (const day of days) {
    for (const studio of studios) {
      const hours = studio.hours[isoWeekday(day)];
      if (!hours) continue;
      start = Math.min(start, hours.openMinute);
      end = Math.max(end, hours.closeMinute);
    }
  }
  for (const item of [...entries, ...blocks]) {
    start = Math.min(start, item.startMinute);
    end = Math.max(end, item.endMinute);
  }
  if (start >= end) return { start: 9 * 60, end: 19 * 60 };
  // Whole hours, with room above and below for the buffers of the first and the last appointment.
  return { start: Math.max(0, Math.floor((start - BUFFER_SHOWN_MINUTES) / 60) * 60), end: Math.min(24 * 60, Math.ceil((end + BUFFER_SHOWN_MINUTES) / 60) * 60) };
}

function HourAxis({ start, end }: { start: number; end: number }) {
  const hours: number[] = [];
  for (let minute = start; minute < end; minute += 60) hours.push(minute);
  return (
    <div className="cal-axis" style={place(0, end - start)} aria-hidden="true">
      {hours.map((minute) => (
        <span key={minute} style={place(minute - start, 60)}>
          {minutesToLabel(minute).replace(":00", "")}
        </span>
      ))}
    </div>
  );
}

/** An appointment on the grid, with its buffers drawn above and below it. */
function GridAppointment({ entry, gridStart, lane, lanes, full }: { entry: Entry; gridStart: number; lane: number; lanes: number; full: boolean }) {
  return (
    <Link
      href={`/admin/appointments/${entry.ref}`}
      className={`cal-appt${full ? " cal-appt-full" : ""}`}
      style={
        {
          ...place(entry.startMinute - gridStart, entry.endMinute - entry.startMinute, entry.studio.color),
          "--lane": lane,
          "--lanes": lanes,
        } as CSSProperties
      }
      title={describe(entry)}
    >
      {/* The inner box clips long text; the buffers are drawn outside it, above and below. */}
      <span className="cal-appt-in">
        <span className="cal-appt-time">
          {full ? `${minutesToLabel(entry.startMinute)} – ${minutesToLabel(entry.endMinute)}` : shortTime(entry.startMinute)}
        </span>
        <span className="cal-appt-name">{entry.customerName}</span>
        {entry.photography && <span className="cal-tag">Photography</span>}
        {full ? (
          <StatusBadge label={entry.label} />
        ) : (
          <span className={`cal-dot status-${entry.label}`} role="img" aria-label={LABEL_TEXT[entry.label]} />
        )}
        <span className="visually-hidden">, {entry.studio.name}</span>
      </span>
    </Link>
  );
}

function GridBlock({ block, gridStart, lane, lanes }: { block: CalendarBlock; gridStart: number; lane: number; lanes: number }) {
  return (
    <div
      className="cal-blocked"
      style={{ ...place(block.startMinute - gridStart, block.endMinute - block.startMinute), "--lane": lane, "--lanes": lanes } as CSSProperties}
      title={`Blocked${block.note ? `: ${block.note}` : ""}`}
    >
      {block.note || "Blocked"}
    </div>
  );
}

// ── Week ─────────────────────────────────────────────────────────────────────

function Week({
  date,
  today,
  entries,
  blocks,
  studios,
  visible,
  dayHref,
}: {
  date: IsoDate;
  today: IsoDate;
  entries: Entry[];
  blocks: CalendarBlock[];
  studios: CatalogStudio[];
  visible: Set<IsoDate>;
  dayHref: (day: IsoDate) => string;
}) {
  const days = weekDays(date);
  const { start, end } = gridHours(days, studios, entries, blocks);
  return (
    <>
      {/* The grid, for screens wide enough for seven days side by side. Each studio has its own lane in a day. */}
      <div className="cal-grid cal-week" style={{ "--days": 7, "--buffer": BUFFER_SHOWN_MINUTES } as CSSProperties}>
        <div className="cal-head">
          <span />
          {days.map((day) => (
            <Link key={day} href={dayHref(day)} className={day === today ? "today" : undefined}>
              {shortDayLabel(day)}
            </Link>
          ))}
        </div>
        <div className="cal-body">
          <HourAxis start={start} end={end} />
          {days.map((day) => (
            <div key={day} className={`cal-col${visible.has(day) ? "" : " unseen"}`} style={place(0, end - start)}>
              {blocks
                .filter((block) => block.date === day)
                .map((block, index) => (
                  <GridBlock key={index} block={block} gridStart={start} lane={studios.findIndex((s) => s.id === block.studioId)} lanes={studios.length} />
                ))}
              {entries
                .filter((entry) => entry.date === day)
                .map((entry) => (
                  <GridAppointment
                    key={`${entry.ref}-${entry.studio.id}`}
                    entry={entry}
                    gridStart={start}
                    lane={studios.findIndex((s) => s.id === entry.studio.id)}
                    lanes={studios.length}
                    full={studios.length === 1}
                  />
                ))}
            </div>
          ))}
        </div>
      </div>

      {/* The same week as a list, day by day, for a phone. */}
      <div className="cal-agenda">
        {days.map((day) => {
          const ofDay = entries.filter((entry) => entry.date === day);
          return (
            <section key={day} className={day === today ? "today" : undefined}>
              <h3>
                <Link href={dayHref(day)}>{longDateLabel(day)}</Link>
              </h3>
              {!visible.has(day) ? (
                <p>Not one of your days.</p>
              ) : ofDay.length === 0 ? (
                <p>No appointments.</p>
              ) : (
                <ul>
                  {ofDay.map((entry) => (
                    <li key={`${entry.ref}-${entry.studio.id}`} style={{ "--studio": entry.studio.color } as CSSProperties}>
                      <Link href={`/admin/appointments/${entry.ref}`}>
                        <span className="cal-agenda-time">
                          {minutesToLabel(entry.startMinute)} – {minutesToLabel(entry.endMinute)}
                        </span>
                        <strong>{entry.customerName}</strong>
                        <span>{entry.studio.name}</span>
                      </Link>
                      <StatusBadge label={entry.label} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}

// ── Day ──────────────────────────────────────────────────────────────────────

function Day({
  date,
  entries,
  blocks,
  studios,
  visible,
}: {
  date: IsoDate;
  entries: Entry[];
  blocks: CalendarBlock[];
  studios: CatalogStudio[];
  visible: boolean;
}) {
  if (!visible) return null;
  const { start, end } = gridHours([date], studios, entries, blocks);
  return (
    <div className="cal-grid cal-day" style={{ "--days": studios.length, "--buffer": BUFFER_SHOWN_MINUTES } as CSSProperties}>
      <div className="cal-head">
        <span />
        {studios.map((studio) => (
          <span key={studio.id} className="cal-studio" style={{ "--studio": studio.color } as CSSProperties}>
            <span className="cal-swatch" aria-hidden="true" />
            {studio.name}
          </span>
        ))}
      </div>
      <div className="cal-body">
        <HourAxis start={start} end={end} />
        {studios.map((studio) => (
          <div key={studio.id} className="cal-col" style={place(0, end - start)}>
            {blocks
              .filter((block) => block.studioId === studio.id)
              .map((block, index) => (
                <GridBlock key={index} block={block} gridStart={start} lane={0} lanes={1} />
              ))}
            {entries
              .filter((entry) => entry.studio.id === studio.id)
              .map((entry) => (
                <GridAppointment key={entry.ref} entry={entry} gridStart={start} lane={0} lanes={1} full />
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
