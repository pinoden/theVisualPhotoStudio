/**
 * Dates for the admin calendar's views: a month, a week, a day, and the agenda (two weeks as a list, from the day
 * chosen; the owner's "From the phone ... I want to have both: agenda view and daily view", 2026-11-23). Pure functions over ISO dates,
 * so they need no time zone: a calendar day is a studio-local day.
 * Weeks run from Sunday to Saturday, as calendars in the United States do.
 */
import { addDays, isoWeekday, parseIsoDate, type IsoDate } from "./time";

export const CALENDAR_VIEWS = ["month", "week", "day", "agenda"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export function isCalendarView(value: unknown): value is CalendarView {
  return typeof value === "string" && (CALENDAR_VIEWS as readonly string[]).includes(value);
}

/**
 * Minutes drawn as a buffer before and after each appointment. Two
 * appointments in one studio are kept at least 15 minutes apart (the studio's
 * `bufferMinutes`), which the owner describes as 7 minutes each side.
 */
export const BUFFER_SHOWN_MINUTES = 7;

/** How many days the agenda lists, from the day chosen; its arrows move by as many. */
export const AGENDA_DAYS = 14;

/** The Sunday on or before `date`. */
export function weekStart(date: IsoDate): IsoDate {
  return addDays(date, -(isoWeekday(date) % 7));
}

export function weekDays(date: IsoDate): IsoDate[] {
  const start = weekStart(date);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

function firstOfMonth(date: IsoDate): IsoDate {
  return `${date.slice(0, 7)}-01`;
}

function addMonths(date: IsoDate, months: number): IsoDate {
  const p = parseIsoDate(date);
  if (!p) throw new Error(`Invalid date: ${date}`);
  const moved = new Date(Date.UTC(p.year, p.month - 1 + months, 1));
  return moved.toISOString().slice(0, 10);
}

/** The whole weeks that cover the month of `date`, each from Sunday to Saturday. */
export function monthWeeks(date: IsoDate): IsoDate[][] {
  const first = firstOfMonth(date);
  const nextMonth = addMonths(first, 1);
  const weeks: IsoDate[][] = [];
  for (let day = weekStart(first); day < nextMonth; day = addDays(day, 7)) weeks.push(weekDays(day));
  return weeks;
}

/** The dates a view shows: `from` is the first, `to` is the day after the last. */
export function rangeOf(view: CalendarView, date: IsoDate): { from: IsoDate; to: IsoDate } {
  if (view === "day") return { from: date, to: addDays(date, 1) };
  if (view === "week") return { from: weekStart(date), to: addDays(weekStart(date), 7) };
  if (view === "agenda") return { from: date, to: addDays(date, AGENDA_DAYS) };
  const weeks = monthWeeks(date);
  return { from: weeks[0][0], to: addDays(weeks.at(-1)![6], 1) };
}

/** The date to show after pressing "next" (`steps` 1) or "previous" (`steps` -1). */
export function shiftDate(view: CalendarView, date: IsoDate, steps: number): IsoDate {
  if (view === "day") return addDays(date, steps);
  if (view === "week") return addDays(date, 7 * steps);
  if (view === "agenda") return addDays(date, AGENDA_DAYS * steps);
  return addMonths(date, steps);
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "November 2026" */
export function monthLabel(date: IsoDate): string {
  const p = parseIsoDate(date);
  return p ? `${MONTHS[p.month - 1]} ${p.year}` : date;
}

/** "Wed 18" */
export function shortDayLabel(date: IsoDate): string {
  const p = parseIsoDate(date);
  return p ? `${SHORT_DAYS[isoWeekday(date) % 7]} ${p.day}` : date;
}

/** "Nov 15 – 21, 2026", or "Nov 29 – Dec 5, 2026" across two months. */
export function weekLabel(date: IsoDate): string {
  return spanLabel(weekStart(date), addDays(weekStart(date), 6));
}

/** The agenda's two weeks from `date`: "Nov 23 – Dec 6, 2026". */
export function agendaLabel(date: IsoDate): string {
  return spanLabel(date, addDays(date, AGENDA_DAYS - 1));
}

function spanLabel(first: IsoDate, last: IsoDate): string {
  const a = parseIsoDate(first)!;
  const b = parseIsoDate(last)!;
  const month = (m: number) => MONTHS[m - 1].slice(0, 3);
  const end = a.month === b.month ? `${b.day}` : `${month(b.month)} ${b.day}`;
  return `${month(a.month)} ${a.day} – ${end}, ${b.year}`;
}
