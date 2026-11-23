"use client";

import { isoWeekday, longDateLabel, type IsoDate } from "@/lib/domain/time";

const WEEKDAYS: [short: string, long: string][] = [
  ["Sun", "Sunday"],
  ["Mon", "Monday"],
  ["Tue", "Tuesday"],
  ["Wed", "Wednesday"],
  ["Thu", "Thursday"],
  ["Fri", "Friday"],
  ["Sat", "Saturday"],
];

/** "2026-12" a number of months later or earlier. */
export function shiftMonth(month: string, by: number): string {
  const [year, number] = month.split("-").map(Number);
  const moved = new Date(Date.UTC(year, number - 1 + by, 1));
  return `${moved.getUTCFullYear()}-${String(moved.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** "December 2026". */
export function monthTitle(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** The month's weeks, Sunday first, with the days of other months left empty. */
export function weeksOf(month: string): (IsoDate | null)[][] {
  const [year, number] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const days: (IsoDate | null)[] = Array.from({ length: last }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`);
  const lead = isoWeekday(`${month}-01`) % 7; // Sunday is 0
  const cells = [...Array<null>(lead).fill(null), ...days];
  while (cells.length % 7 !== 0) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, week) => cells.slice(week * 7, week * 7 + 7));
}

/**
 * The booking page's month calendar (the owner's brief of 2026-11-22, item 3): the whole month, larger, in the
 * original website's warm tans, with the months before and after. Only the days on which the chosen length fits can
 * be chosen (`days`, from `/api/availability/month`); the others are muted and cannot be pressed.
 */
export function MonthCalendar({
  month,
  firstMonth,
  lastMonth,
  days,
  selected,
  onMonth,
  onChoose,
}: {
  month: string;
  firstMonth: string;
  lastMonth: string;
  /** Whether the length fits on each day; null while it is being read. */
  days: Record<IsoDate, boolean> | null;
  selected: IsoDate | "";
  onMonth: (month: string) => void;
  onChoose: (date: IsoDate) => void;
}) {
  const open = days ? Object.values(days).filter(Boolean).length : 0;
  return (
    <div className="month-cal" aria-busy={days === null}>
      <div className="month-cal-head">
        <button type="button" className="month-cal-nav" aria-label="Previous month" disabled={month <= firstMonth} onClick={() => onMonth(shiftMonth(month, -1))}>
          ‹
        </button>
        <h4 className="month-cal-title" aria-live="polite">
          {monthTitle(month)}
        </h4>
        <button type="button" className="month-cal-nav" aria-label="Following month" disabled={month >= lastMonth} onClick={() => onMonth(shiftMonth(month, 1))}>
          ›
        </button>
      </div>
      <table className="month-cal-grid">
        <thead>
          <tr>
            {WEEKDAYS.map(([short, long]) => (
              <th key={short} scope="col">
                <abbr title={long}>{short}</abbr>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeksOf(month).map((week, index) => (
            <tr key={index}>
              {week.map((day, column) => (
                <td key={day ?? `empty-${column}`}>
                  {day && (
                    <button
                      type="button"
                      className="month-cal-day"
                      disabled={!days?.[day]}
                      aria-pressed={day === selected}
                      aria-label={`${longDateLabel(day)}${days?.[day] ? "" : ", not available"}`}
                      onClick={() => onChoose(day)}
                    >
                      {Number(day.slice(8))}
                    </button>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="month-cal-note" role="status">
        {days === null
          ? "Checking which days are free…"
          : open === 0
            ? "No day this month has a free time for this length. Try the next month, or a shorter length."
            : "Only the days on which your length fits can be chosen."}
      </p>
    </div>
  );
}
