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

/** The days of a code released from a rental booked for a weekday: Monday to Friday, not a holiday (the owner, 2026-11-28). */
export const WEEKDAYS_ONLY: PromoDays = { from: null, until: null, weekdays: [1, 2, 3, 4, 5], notOnSpecialDates: true };

/** A schedule that limits nothing is no schedule. */
export function isLimiting(days: PromoDays | null | undefined): days is PromoDays {
  if (!days) return false;
  const weekdays = new Set(days.weekdays);
  return days.from !== null || days.until !== null || (weekdays.size > 0 && weekdays.size < 7) || days.notOnSpecialDates;
}

/** Why a booking on `date` may not use a code with these days, or null when it may. `special`: the date is under Holidays and special dates. */
function promoDayProblem(days: PromoDays | null | undefined, date: IsoDate, special: boolean): "outside" | "weekday" | "holiday" | null {
  if (!isLimiting(days)) return null;
  if ((days.from && date < days.from) || (days.until && date > days.until)) return "outside";
  if (days.weekdays.length > 0 && !days.weekdays.includes(isoWeekday(date))) return "weekday";
  if (days.notOnSpecialDates && special) return "holiday";
  return null;
}

/** Whether a booking on `date` may use a code with these days. */
export const promoFitsDay = (days: PromoDays | null | undefined, date: IsoDate, special: boolean): boolean => promoDayProblem(days, date, special) === null;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dateWords = (date: IsoDate, withYear = true) => {
  const p = parseIsoDate(date)!;
  return withYear ? `${MONTHS[p.month - 1]} ${p.day}, ${p.year}` : `${MONTHS[p.month - 1]} ${p.day}`;
};

/** "from January 15 to February 15, 2027", the year once when both are in it. */
function rangeWords(from: IsoDate, until: IsoDate): string {
  if (from === until) return `on ${dateWords(from)}`;
  return from.slice(0, 4) === until.slice(0, 4) ? `from ${dateWords(from, false)} to ${dateWords(until)}` : `from ${dateWords(from)} to ${dateWords(until)}`;
}

/** "on weekdays (Monday to Friday)", "on weekends (Saturday and Sunday)", "Monday to Thursday", "on Mondays and Wednesdays". */
function weekdaysWords(weekdays: number[]): string | null {
  const sorted = [...new Set(weekdays)].filter((day) => day >= 1 && day <= 7).sort();
  if (sorted.length === 0 || sorted.length === 7) return null;
  const key = sorted.join("");
  if (key === "12345") return "on weekdays (Monday to Friday)";
  if (key === "67") return "on weekends (Saturday and Sunday)";
  const run = sorted.every((day, i) => i === 0 || day === sorted[i - 1] + 1);
  if (run && sorted.length > 2) return `${weekdayName(sorted[0])} to ${weekdayName(sorted.at(-1)!)}`;
  const names = sorted.map((day) => `${weekdayName(day)}s`);
  return `on ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`}`;
}

/** "bookings from January 15, 2027 to February 15, 2027, Monday to Friday, not on holidays": null for any day. */
export function promoDaysInWords(days: PromoDays | null | undefined): string | null {
  if (!isLimiting(days)) return null;
  const parts: string[] = [];
  if (days.from && days.until) parts.push(rangeWords(days.from, days.until));
  else if (days.from) parts.push(`from ${dateWords(days.from)}`);
  else if (days.until) parts.push(`until ${dateWords(days.until)}`);
  const week = weekdaysWords(days.weekdays);
  if (week) parts.push(week);
  if (days.notOnSpecialDates) parts.push("not on holidays");
  return `bookings ${parts.join(", ")}`;
}

/**
 * What the client reads when a code does not fit the day chosen: the days it works for, why that day is not one of them,
 * and what to do. "That code works only for bookings on weekdays (Monday to Friday). December 12, 2026 is a Saturday.
 * Choose another date, or book without the code."
 */
export function promoDayMisfitText(days: PromoDays | null | undefined, date: IsoDate | null, special: boolean): string {
  const words = promoDaysInWords(days);
  const opening = words ? `That code works only for ${words}.` : "That code cannot be used for a booking on that day.";
  const problem = date && isIsoDate(date) ? promoDayProblem(days, date, special) : null;
  const why =
    problem === "outside"
      ? ` ${longDate(date!)} is outside those dates.`
      : problem === "weekday"
        ? ` ${dateWords(date!)} is a ${weekdayName(isoWeekday(date!))}.`
        : problem === "holiday"
          ? ` ${longDate(date!)} is a holiday.`
          : "";
  return `${opening}${why} Choose another date, or book without the code.`;
}

const longDate = (date: IsoDate) => `${weekdayName(isoWeekday(date))}, ${dateWords(date)}`;

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
