import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense, type CSSProperties } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { getDb } from "@/db/client";
import { studios as studiosTable } from "@/db/schema";
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
import { appointmentLook, calendarColumns, hoursText, lanesOf, type AppointmentLook } from "@/lib/domain/appointment-look";
import { LABEL_TEXT } from "@/lib/domain/labels";
import { isIsoDate, isoWeekday, longDateLabel, minutesToLabel, type IsoDate } from "@/lib/domain/time";
import { can } from "@/lib/abilities";
import { studioCombinationError } from "@/lib/catalog-view";
import { count } from "@/lib/words";
import { getAppointment, moveOptions } from "@/server/appointments";
import { loadCalendar, type CalendarAppointment, type CalendarBlock } from "@/server/calendar";
import { loadCatalog, type CatalogStudio } from "@/server/catalog";
import { requireStaff } from "@/server/session";
import { localDateOf } from "@/server/tz";
import { AdminFrame, AdminLoading } from "../frame";
import { AppointmentDialog } from "./AppointmentDialog";

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

/** One appointment as the calendar draws it: once, a bundle too, in the studios it holds among those shown. */
interface Entry extends CalendarAppointment {
  held: CatalogStudio[];
  look: AppointmentLook;
  /** The calendar as it is, with this appointment open over it. */
  openHref: string;
}

/**
 * How large the time grid is drawn: a minute's height in pixels for each of the zoom buttons (the owner's admin brief
 * of 2026-11-22, item 9, as in Acuity). It changes no length and no step. 0.5 is the size the calendar had before.
 */
const ZOOMS = { "0.25": 0.7, "0.5": 1.15, "0.75": 1.8 } as const;
type Zoom = keyof typeof ZOOMS;
const isZoom = (value: unknown): value is Zoom => typeof value === "string" && Object.hasOwn(ZOOMS, value);

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
  // Paris in the middle, so that every bundle is side by side and drawn as one appointment.
  const studios = chosen ? [chosen] : calendarColumns(catalog.studios);
  const zoom: Zoom = isZoom(query.zoom) ? query.zoom : "0.5";

  const span = rangeOf(view, date);
  const data = await loadCalendar(db, viewer, catalog, span);
  const visible = new Set(data.days);

  const href = (to: { view?: CalendarView; date?: IsoDate; studio?: string | null; zoom?: Zoom; open?: string }) => {
    const studio = to.studio === undefined ? (chosen?.slug ?? null) : to.studio;
    const scale = to.zoom ?? zoom;
    return `/admin/calendar?view=${to.view ?? view}&date=${to.date ?? date}${studio ? `&studio=${studio}` : ""}${scale === "0.5" ? "" : `&zoom=${scale}`}${to.open ? `&open=${encodeURIComponent(to.open)}` : ""}`;
  };
  // One entry for each appointment that holds a studio being shown. It keeps its bundle's name and colour when one studio is shown.
  const entries: Entry[] = data.appointments.flatMap((appointment) => {
    const held = studios.filter((studio) => appointment.studioIds.includes(studio.id));
    const all = catalog.studios.filter((studio) => appointment.studioIds.includes(studio.id));
    return held.length === 0 ? [] : [{ ...appointment, held, look: appointmentLook(all, appointment.photography), openHref: href({ open: appointment.ref }) }];
  });
  const blocks = data.blocks.filter((block) => studios.some((studio) => studio.id === block.studioId));

  const mayBook = can(viewer, "createBookings", catalog.settings);

  // The appointment open over the calendar, if one is (the owner's admin brief of 2026-11-22, item 5): one this viewer
  // may see. Its colour comes from every studio, a studio taken off the site since included.
  const openRef = typeof query.open === "string" ? query.open : null;
  const opened = openRef ? await getAppointment(db, viewer, openRef, new Date()) : null;
  const openedLook = opened
    ? appointmentLook(
        (await db.select({ id: studiosTable.id, slug: studiosTable.slug, name: studiosTable.name, color: studiosTable.color }).from(studiosTable)).filter((studio) =>
          opened.studios.includes(studio.name),
        ),
        opened.photography !== null,
      )
    : null;
  // Rescheduling inside the pop-up (item 5): `&move=<date>` shows the times free on that date, as the appointment's page does.
  const moving = opened !== null && opened.may.move && typeof query.move === "string";
  const moveDate = moving && !opened.moveBlocked && typeof query.move === "string" && isIsoDate(query.move) ? query.move : null;
  const moveTimes = opened && moveDate ? await moveOptions(db, viewer, opened.ref, moveDate, new Date()) : null;
  const openedHref = opened ? href({ open: opened.ref }) : "";
  const move = opened && moving
    ? {
        date: moveDate,
        times: moveTimes,
        dateForm: {
          action: "/admin/calendar",
          keep: { view, date, ...(chosen ? { studio: chosen.slug } : {}), ...(zoom === "0.5" ? {} : { zoom }), open: opened.ref },
        },
        back: openedHref,
        closeHref: openedHref,
      }
    : null;
  const bookAnother =
    opened && mayBook && opened.customerEmail !== null
      ? `/admin/calendar/new?date=${date}&clientName=${encodeURIComponent(opened.customerName)}&clientEmail=${encodeURIComponent(opened.customerEmail)}&clientPhone=${encodeURIComponent(opened.customerPhone ?? "")}`
      : null;

  // How many appointments the day, the week or the month holds (the owners' note of 2026-11-22), in the studios shown.
  const inSpan = entries.filter((entry) => (view === "month" ? entry.date.slice(0, 7) === date.slice(0, 7) : view === "day" ? entry.date === date : true));
  const spanCount = `${count(inSpan.length, "appointment")} ${view === "day" ? "this day" : view === "week" ? "this week" : "this month"}`;
  // The bundles of the studios shown, for the key under the grid.
  const bundles = studios.length < 2 ? [] : bundlesOf(studios);
  const title = view === "month" ? monthLabel(date) : view === "week" ? weekLabel(date) : longDateLabel(date);

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
          <p className="cal-count">{spanCount}</p>
        </div>
        <form method="get" className="cal-jump">
          <input type="hidden" name="view" value={view} />
          {chosen && <input type="hidden" name="studio" value={chosen.slug} />}
          {zoom !== "0.5" && <input type="hidden" name="zoom" value={zoom} />}
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
        {view !== "month" && (
          <nav className="cal-tabs cal-zoom" aria-label="Zoom">
            {(Object.keys(ZOOMS) as Zoom[]).map((scale) => (
              <Link key={scale} href={href({ zoom: scale })} aria-current={scale === zoom ? "true" : undefined}>
                {scale}
              </Link>
            ))}
          </nav>
        )}
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
        <Week date={date} today={today} entries={entries} blocks={blocks} studios={studios} visible={visible} ppm={ZOOMS[zoom]} dayHref={(day) => href({ view: "day", date: day })} />
      )}
      {view === "day" && <Day date={date} entries={entries} blocks={blocks} studios={studios} visible={visible.has(date)} ppm={ZOOMS[zoom]} />}

      {view !== "month" && (
        <p className="cal-legend">
          <span className="cal-legend-buffer" aria-hidden="true" /> The {BUFFER_SHOWN_MINUTES} minutes kept free before and after
          each appointment.
          <span className="cal-legend-block" aria-hidden="true" /> Time the studio blocked.
        </p>
      )}
      {opened && openedLook && (
        <AppointmentDialog
          appointment={opened}
          look={openedLook}
          closeHref={href({})}
          bookAnotherHref={bookAnother}
          rescheduleHref={`${openedHref}&move=${localDateOf(new Date(opened.startAt))}`}
          move={move}
          today={today}
        />
      )}
      {bundles.length > 0 && (
        <p className="cal-legend cal-key">
          {bundles.map((bundle) => (
            <span key={bundle.name} className="cal-studio" style={{ "--studio": bundle.color } as CSSProperties}>
              <span className="cal-swatch" aria-hidden="true" />
              {bundle.name}
            </span>
          ))}
          <span>A photography session is a deeper shade of its studio&rsquo;s or bundle&rsquo;s colour.</span>
        </p>
      )}
    </AdminFrame>
  );
}

/** Every bundle the studios shown can make, with its name and colour. */
function bundlesOf(studios: CatalogStudio[]): AppointmentLook[] {
  const found: AppointmentLook[] = [];
  for (let mask = 1; mask < 1 << studios.length; mask++) {
    const held = studios.filter((_, index) => mask & (1 << index));
    if (held.length < 2 || studioCombinationError(studios, held.map((studio) => studio.id)) !== null) continue;
    found.push(appointmentLook(held, false));
  }
  return found.sort((a, b) => a.name.split(" + ").length - b.name.split(" + ").length || a.name.localeCompare(b.name));
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
                      <AppointmentChip key={entry.ref} entry={entry} />
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

/** "Dayglow · 1.5 hours": the studio or bundle, and the length (the owner's admin brief of 2026-11-22, item 4). */
const whatAndHowLong = (entry: Entry) => `${entry.look.name} · ${hoursText(entry.endMinute - entry.startMinute)}`;

const describe = (entry: Entry) =>
  `${minutesToLabel(entry.startMinute)} – ${minutesToLabel(entry.endMinute)}, ${entry.customerName}, ${whatAndHowLong(entry)}, ${LABEL_TEXT[entry.label]}${entry.photography ? ", photography session" : ""}`;

/** An appointment as one line: its time and the client's name, in its studio's colour, with a dot for its status. */
function AppointmentChip({ entry }: { entry: Entry }) {
  return (
    <Link
      href={entry.openHref}
      scroll={false}
      className="cal-chip"
      style={{ "--studio": entry.look.color } as CSSProperties}
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

/**
 * An appointment on the grid, with its buffers drawn above and below it: across `span` lanes from `lane`, so that a
 * bundle is one appointment over its studios. What it says, as the owner wrote it: the client, the studio or bundle
 * and the length, and the time and status where there is room.
 */
function GridAppointment({ entry, gridStart, lane, span, lanes, full }: { entry: Entry; gridStart: number; lane: number; span: number; lanes: number; full: boolean }) {
  return (
    <Link
      href={entry.openHref}
      scroll={false}
      className={`cal-appt${full || span > 1 ? " cal-appt-full" : ""}${entry.look.bundle ? " cal-appt-bundle" : ""}`}
      style={
        {
          ...place(entry.startMinute - gridStart, entry.endMinute - entry.startMinute, entry.look.color),
          "--lane": lane,
          "--span": span,
          "--lanes": lanes,
        } as CSSProperties
      }
      title={describe(entry)}
    >
      {/* The inner box clips long text; the buffers are drawn outside it, above and below. */}
      <span className="cal-appt-in">
        <span className="cal-appt-name">{entry.customerName}</span>
        <span className="cal-appt-what">{whatAndHowLong(entry)}</span>
        <span className="cal-appt-time">
          {full || span > 1 ? `${minutesToLabel(entry.startMinute)} – ${minutesToLabel(entry.endMinute)}` : shortTime(entry.startMinute)}
        </span>
        {entry.photography && <span className="cal-tag">Photography</span>}
        {full || span > 1 ? (
          <StatusBadge label={entry.label} />
        ) : (
          <span className={`cal-dot status-${entry.label}`} role="img" aria-label={LABEL_TEXT[entry.label]} />
        )}
      </span>
    </Link>
  );
}

/** An appointment's places among the lanes: one for each run of studios side by side that it holds. */
const runsOf = (entry: Entry, studios: CatalogStudio[]) => lanesOf(entry.held.map((studio) => studio.id), studios);

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
  ppm,
  dayHref,
}: {
  date: IsoDate;
  today: IsoDate;
  entries: Entry[];
  blocks: CalendarBlock[];
  studios: CatalogStudio[];
  visible: Set<IsoDate>;
  ppm: number;
  dayHref: (day: IsoDate) => string;
}) {
  const days = weekDays(date);
  const ofDay = (day: IsoDate) => entries.filter((entry) => entry.date === day);
  const { start, end } = gridHours(days, studios, entries, blocks);
  return (
    <>
      {/* The grid, for screens wide enough for seven days side by side. Each studio has its own lane in a day. */}
      <div className="cal-grid cal-week" style={{ "--days": 7, "--buffer": BUFFER_SHOWN_MINUTES, "--ppm": `${ppm}px` } as CSSProperties}>
        <div className="cal-head">
          <span />
          {days.map((day) => (
            <Link key={day} href={dayHref(day)} className={day === today ? "today" : undefined}>
              {shortDayLabel(day)}
              {visible.has(day) && <span className="cal-head-count"> · {ofDay(day).length}</span>}
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
              {ofDay(day).flatMap((entry) =>
                runsOf(entry, studios).map((run) => (
                  <GridAppointment
                    key={`${entry.ref}-${run.lane}`}
                    entry={entry}
                    gridStart={start}
                    lane={run.lane}
                    span={run.span}
                    lanes={studios.length}
                    full={studios.length === 1}
                  />
                )),
              )}
            </div>
          ))}
        </div>
      </div>

      {/* The same week as a list, day by day, for a phone. */}
      <div className="cal-agenda">
        {days.map((day) => {
          const listed = ofDay(day);
          return (
            <section key={day} className={day === today ? "today" : undefined}>
              <h3>
                <Link href={dayHref(day)}>{longDateLabel(day)}</Link>
                {visible.has(day) && listed.length > 0 && <span className="cal-head-count"> · {count(listed.length, "appointment")}</span>}
              </h3>
              {!visible.has(day) ? (
                <p>Not one of your days.</p>
              ) : listed.length === 0 ? (
                <p>No appointments.</p>
              ) : (
                <ul>
                  {listed.map((entry) => (
                    <li key={entry.ref} style={{ "--studio": entry.look.color } as CSSProperties}>
                      <Link href={entry.openHref} scroll={false}>
                        <span className="cal-agenda-time">
                          {minutesToLabel(entry.startMinute)} – {minutesToLabel(entry.endMinute)}
                        </span>
                        <strong>{entry.customerName}</strong>
                        <span>{whatAndHowLong(entry)}</span>
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
  ppm,
}: {
  date: IsoDate;
  entries: Entry[];
  blocks: CalendarBlock[];
  studios: CatalogStudio[];
  visible: boolean;
  ppm: number;
}) {
  if (!visible) return null;
  const { start, end } = gridHours([date], studios, entries, blocks);
  return (
    <div className="cal-grid cal-day" style={{ "--days": studios.length, "--buffer": BUFFER_SHOWN_MINUTES, "--ppm": `${ppm}px` } as CSSProperties}>
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
          </div>
        ))}
        {/* The appointments over the studios' columns, so that a bundle is one appointment across its studios. */}
        <div className="cal-lanes" style={{ "--lanes": studios.length } as CSSProperties}>
          {entries.flatMap((entry) =>
            runsOf(entry, studios).map((run) => (
              <GridAppointment key={`${entry.ref}-${run.lane}`} entry={entry} gridStart={start} lane={run.lane} span={run.span} lanes={studios.length} full />
            )),
          )}
        </div>
      </div>
    </div>
  );
}
