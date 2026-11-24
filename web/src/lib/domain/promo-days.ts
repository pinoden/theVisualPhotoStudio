import { isIsoDate, isoWeekday, parseIsoDate, weekdayName, type IsoDate } from "./time";

/**
 * The days a code can be booked for (the owner's request of 2026-11-23: a Valentine's code "between January 15th and
 * February 15th", or codes "people won't be able to use ... on the weekends or holidays"; question 80 in
 * ProjectLibrary.md). They are the days of the booking, not the day the client enters the code: when it can be entered
 * stays the code's "Valid for", its expiry. Set by an owner on Admin → Codes; nothing set, any day.
 */
export interface PromoDays {
  /** The first and the last day a booking may be on, both included; null for no limit that side. */
  from: IsoDate | null;
  until: IsoDate | null;
  /** The days of the week (1 Monday to 7 Sunday) it is for; empty or all seven, every day. */
  weekdays: number[];
  /** Not on the dates listed under Prices → Holidays and special dates. */
  notOnSpecialDates: boolean;
}

/** A schedule that limits nothing is no schedule. */
export function isLimiting(days: PromoDays | null | undefined): days is PromoDays {
  if (!days) return false;
  const weekdays = new Set(days.weekdays);
  return days.from !== null || days.until !== null || (weekdays.size > 0 && weekdays.size < 7) || days.notOnSpecialDates;
}

/** Whether a booking on `date` may use a code with these days. `special`: the date is under Holidays and special dates. */
export function promoFitsDay(days: PromoDays | null | undefined, date: IsoDate, special: boolean): boolean {
  if (!isLimiting(days)) return true;
  if (days.from && date < days.from) return false;
  if (days.until && date > days.until) return false;
  if (days.weekdays.length > 0 && !days.weekdays.includes(isoWeekday(date))) return false;
  if (days.notOnSpecialDates && special) return false;
  return true;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dateWords = (date: IsoDate) => {
  const p = parseIsoDate(date)!;
  return `${MONTHS[p.month - 1]} ${p.day}, ${p.year}`;
};

/** Mondays to Fridays, as "Monday to Friday"; others as a list. */
function weekdaysWords(weekdays: number[]): string | null {
  const sorted = [...new Set(weekdays)].filter((day) => day >= 1 && day <= 7).sort();
  if (sorted.length === 0 || sorted.length === 7) return null;
  const run = sorted.every((day, i) => i === 0 || day === sorted[i - 1] + 1);
  if (run && sorted.length > 2) return `${weekdayName(sorted[0])} to ${weekdayName(sorted.at(-1)!)}`;
  const names = sorted.map((day) => `${weekdayName(day)}s`);
  return names.length === 1 ? `${names[0]} only` : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "bookings from January 15, 2027 to February 15, 2027, Monday to Friday, not on holidays": null for any day. */
export function promoDaysInWords(days: PromoDays | null | undefined): string | null {
  if (!isLimiting(days)) return null;
  const parts: string[] = [];
  if (days.from && days.until) parts.push(days.from === days.until ? `on ${dateWords(days.from)}` : `from ${dateWords(days.from)} to ${dateWords(days.until)}`);
  else if (days.from) parts.push(`from ${dateWords(days.from)}`);
  else if (days.until) parts.push(`until ${dateWords(days.until)}`);
  const week = weekdaysWords(days.weekdays);
  if (week) parts.push(week);
  if (days.notOnSpecialDates) parts.push("not on holidays");
  return `bookings ${parts.join(", ")}`;
}

/** The days as stored (`promo_codes.booking_days`), read back carefully: anything that is not one reads as any day. */
export function readPromoDays(value: unknown): PromoDays | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const date = (x: unknown) => (typeof x === "string" && isIsoDate(x) ? x : null);
  const days: PromoDays = {
    from: date(v.from),
    until: date(v.until),
    weekdays: Array.isArray(v.weekdays) ? v.weekdays.filter((d): d is number => Number.isInteger(d) && d >= 1 && d <= 7) : [],
    notOnSpecialDates: v.notOnSpecialDates === true,
  };
  return isLimiting(days) ? days : null;
}

/** What is wrong with days an owner chose, or null. */
export function promoDaysProblem(days: PromoDays): string | null {
  if (days.from && days.until && days.until < days.from) return "The last booking day must be on or after the first.";
  if (days.weekdays.length === 0) return "Tick at least one day of the week.";
  return null;
}
