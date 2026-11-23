import { isoWeekday, type IsoDate } from "./time";

/** Months as "2026-12", for the month calendars of the booking page and of blocked time. */

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
