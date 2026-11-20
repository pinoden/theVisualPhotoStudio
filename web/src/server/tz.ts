/**
 * Conversion between the studio's wall-clock time and real instants.
 * Server only (uses the time zone database through luxon).
 */
import { DateTime } from "luxon";
import { parseIsoDate, STUDIO_TIME_ZONE, type IsoDate } from "@/lib/domain/time";

const STUDIO_TZ = STUDIO_TIME_ZONE;

/**
 * The instant at which the studio's clocks show `minute` past midnight on
 * `date`. Minutes of 1440 or more fall on the following day(s), so a booking
 * that ends exactly at midnight is representable.
 */
export function localToUtc(date: IsoDate, minute: number): Date {
  const p = parseIsoDate(date);
  if (!p || !Number.isInteger(minute) || minute < 0) throw new Error(`Invalid local time: ${date} ${minute}`);
  const dayOffset = Math.floor(minute / 1440);
  const inDay = minute % 1440;
  const dt = DateTime.fromObject(
    { year: p.year, month: p.month, day: p.day, hour: Math.floor(inDay / 60), minute: inDay % 60 },
    { zone: STUDIO_TZ },
  ).plus({ days: dayOffset });
  if (!dt.isValid) throw new Error(`Invalid local time: ${date} ${minute}`);
  return dt.toJSDate();
}

export function localDateOf(instant: Date): IsoDate {
  return DateTime.fromJSDate(instant, { zone: STUDIO_TZ }).toFormat("yyyy-LL-dd");
}

/**
 * Wall-clock minutes of `instant` measured on `date`, clamped to the day:
 * 0 if the instant is before that day, 1440 if it is after.
 */
export function localMinuteOn(instant: Date, date: IsoDate): number {
  const dt = DateTime.fromJSDate(instant, { zone: STUDIO_TZ });
  const d = dt.toFormat("yyyy-LL-dd");
  if (d < date) return 0;
  if (d > date) return 1440;
  return dt.hour * 60 + dt.minute + (dt.second > 0 || dt.millisecond > 0 ? 1 : 0);
}

/** Same as localMinuteOn but rounds down; used for the start of busy spans. */
export function localMinuteOnFloor(instant: Date, date: IsoDate): number {
  const dt = DateTime.fromJSDate(instant, { zone: STUDIO_TZ });
  const d = dt.toFormat("yyyy-LL-dd");
  if (d < date) return 0;
  if (d > date) return 1440;
  return dt.hour * 60 + dt.minute;
}

/**
 * The wall-clock minutes of `date` that do not happen exactly once: the hour
 * the clocks skip when they go forward (2:00 to 3:00), or the hour they show
 * twice when they go back (1:00 to 2:00). Null on any other day. A booking
 * that started, ended or ran across them would not last as long as it costs,
 * so they are taken time in every studio's day.
 */
export function clockChangeOn(date: IsoDate): { start: number; end: number } | null {
  const p = parseIsoDate(date);
  if (!p) return null;
  const midnight = DateTime.fromObject({ year: p.year, month: p.month, day: p.day }, { zone: STUDIO_TZ });
  const before = midnight.offset;
  const after = midnight.plus({ days: 1 }).minus({ minutes: 1 }).offset;
  if (before === after) return null;
  const shift = Math.abs(after - before);
  // Real time from midnight, in quarter hours, until the clocks have changed. Until then real and wall-clock minutes agree.
  for (let minute = 15; minute <= 1440; minute += 15) {
    if (midnight.plus({ minutes: minute }).offset === before) continue;
    return after > before ? { start: minute, end: minute + shift } : { start: minute - shift, end: minute };
  }
  return null;
}

/** The instants at which the given local day starts and ends. */
export function dayBoundsUtc(date: IsoDate): { start: Date; end: Date } {
  const p = parseIsoDate(date);
  if (!p) throw new Error(`Invalid date: ${date}`);
  const start = DateTime.fromObject({ year: p.year, month: p.month, day: p.day }, { zone: STUDIO_TZ });
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate() };
}

/** "Sat, Nov 21, 2026, 10:00 AM" in studio time. */
export function formatInstant(instant: Date): string {
  return DateTime.fromJSDate(instant, { zone: STUDIO_TZ }).toFormat("ccc, LLL d, yyyy, h:mm a");
}

/** "Nov 21, 2026" in studio time: a day, for a list of dates. */
export function formatDay(instant: Date): string {
  return DateTime.fromJSDate(instant, { zone: STUDIO_TZ }).toFormat("LLL d, yyyy");
}

/** "Saturday, November 21, 2026" and "10:00 AM – 12:00 PM" in studio time. */
export function formatRange(start: Date, end: Date): { day: string; time: string } {
  const a = DateTime.fromJSDate(start, { zone: STUDIO_TZ });
  const b = DateTime.fromJSDate(end, { zone: STUDIO_TZ });
  return { day: a.toFormat("cccc, LLLL d, yyyy"), time: `${a.toFormat("h:mm a")} – ${b.toFormat("h:mm a")}` };
}
