"use client";

import { monthTitle, shiftMonth, weeksOf } from "@/lib/domain/months";
import { longDateLabel, type IsoDate } from "@/lib/domain/time";

const WEEKDAYS: [short: string, long: string][] = [
  ["Sun", "Sunday"],
  ["Mon", "Monday"],
  ["Tue", "Tuesday"],
  ["Wed", "Wednesday"],
  ["Thu", "Thursday"],
  ["Fri", "Friday"],
  ["Sat", "Saturday"],
];

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
      {/* The same size whatever it says, so that nothing below it moves when the month's answer comes: a press on "Next"
          a moment after choosing the duration lands where it was aimed (the phone test in WebKit, 2026-11-22). While the
          answer is on its way the days are dimmed and cannot be pressed. */}
      <p className="month-cal-note" role="status">
        {days !== null && open === 0 ? "No free day this month for this length." : "Only the days on which your length fits can be chosen."}
      </p>
    </div>
  );
}
