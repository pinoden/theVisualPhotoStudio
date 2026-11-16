/**
 * Calendar helpers that need no time zone database, so they are safe to use
 * in the browser. A booking day is an ISO date string plus minutes from local
 * midnight in the studio's time zone. Conversion to real instants lives in
 * `src/server/tz.ts`.
 */

export type IsoDate = string; // 'YYYY-MM-DD'
export type DayType = "weekday" | "weekend";

/** The studio's time zone. `src/server/tz.ts` converts with it; the browser only asks it for today's date. */
export const STUDIO_TIME_ZONE = "America/New_York";

const studioDate = new Intl.DateTimeFormat("en-CA", { timeZone: STUDIO_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** Today's date on the studio's clock, wherever the device that asks is. */
export function studioToday(now: Date = new Date()): IsoDate {
  return studioDate.format(now);
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoDate(value: string): { year: number; month: number; day: number } | null {
  const m = ISO_DATE.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  // Reject impossible dates such as 2026-02-30, which Date silently rolls over.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

export function isIsoDate(value: string): boolean {
  return parseIsoDate(value) !== null;
}

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(date: IsoDate): number {
  const p = parseIsoDate(date);
  if (!p) throw new Error(`Invalid date: ${date}`);
  const js = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(); // 0 = Sunday
  return js === 0 ? 7 : js;
}

/** Saturday and Sunday are weekend unless a special date overrides it. */
export function defaultDayType(date: IsoDate): DayType {
  return isoWeekday(date) >= 6 ? "weekend" : "weekday";
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const p = parseIsoDate(date);
  if (!p) throw new Error(`Invalid date: ${date}`);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  if (!a || !b) throw new Error("Invalid date");
  const ms = Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day);
  return Math.round(ms / 86_400_000);
}

export function minutesToHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 540 -> "9:00 AM" */
export function minutesToLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/**
 * 60 -> "1 hour", 90 -> "1.5 hours", 45 -> "45 minutes", 75 -> "1 hour 15 minutes".
 * Hours get a decimal only for a half: a quarter of an hour would read "0.3 hours".
 */
export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  if (minutes % 30 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} ${hours === 1 ? "hour" : "hours"} ${rest} ${rest === 1 ? "minute" : "minutes"}`;
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "Saturday, November 21, 2026" */
export function longDateLabel(date: IsoDate): string {
  const p = parseIsoDate(date);
  if (!p) return date;
  return `${WEEKDAYS[isoWeekday(date) - 1]}, ${MONTHS[p.month - 1]} ${p.day}, ${p.year}`;
}

export function weekdayName(weekday: number): string {
  return WEEKDAYS[weekday - 1];
}
