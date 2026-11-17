/** Reading what people type into forms. Each returns null for anything it does not understand. */

/**
 * "88", "88.5", "$1,500.00" -> cents. Never uses floating point.
 *
 * A comma is accepted only where it separates thousands. "12,50" is how much
 * of the world writes twelve and a half; reading it as 1250 would save a price
 * a hundred times too high, so it is not understood at all.
 */
export function dollarsToCents(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const match = DOLLARS.exec(raw);
  if (!match) return null;
  return Number(match[1].replace(/,/g, "")) * 100 + Number((match[2] ?? "").slice(1).padEnd(2, "0"));
}

/** What `dollarsToCents` understands, as a pattern. Up to 9,999,999.99. */
export const DOLLARS_PATTERN = String.raw`\s*\$?(\d{1,7}|\d{1,3},\d{3}|\d,\d{3},\d{3})(\.\d{1,2})?\s*`;
const DOLLARS = new RegExp(`^${DOLLARS_PATTERN}$`);

/** A price: an amount in dollars of at most $100,000, which the server keeps to (`PRICE_MAX_CENTS`). */
export const PRICE_PATTERN = String.raw`\s*\$?((\d{1,5}|\d{1,2},\d{3})(\.\d{1,2})?|100,?000(\.0{1,2})?)\s*`;

/** An amount in dollars above zero, as a code's credit must be. */
export const POSITIVE_DOLLARS_PATTERN = String.raw`(?!\s*\$?0*(\.0*)?\s*$)${DOLLARS_PATTERN}`;

/**
 * Attributes for a money field. The browser checks the same pattern before
 * the form is sent, so a mistyped amount is pointed out with everything else
 * on the form still as it was typed.
 */
export const MONEY_FIELD = {
  inputMode: "decimal",
  pattern: DOLLARS_PATTERN,
  title: "An amount in dollars, for example 40 or 40.50",
} as const;

/** A money field for a price: the same, up to $100,000. */
export const PRICE_FIELD = { inputMode: "decimal", pattern: PRICE_PATTERN, title: "An amount in dollars up to 100,000, for example 88 or 88.50" } as const;

/** A money field for a code's credit: the same, above zero. */
export const CREDIT_FIELD = { inputMode: "decimal", pattern: POSITIVE_DOLLARS_PATTERN, title: "An amount in dollars above zero, for example 40 or 40.50" } as const;

/**
 * Text from a form field or a request, ready to measure and store.
 *
 * A browser sends each line break as two characters (CR LF) while a field's
 * `maxlength` counts it as one, so line breaks are made single here: otherwise
 * text the field accepted would be refused as too long. A NUL character, which
 * PostgreSQL cannot store, is dropped. Anything that is not text becomes "".
 */
export function formText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replaceAll("\u0000", "").replace(/\r\n?/g, "\n").trim();
}

/** 8800 -> "88", 8850 -> "88.50". For pre-filling money inputs. */
export function centsToInput(cents: number): string {
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, "0")}`;
}

/** "09:30" -> 570. "24:00" is allowed as the end of a day. */
export function hhmmToMinutes(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59 || hours > 24 || (hours === 24 && minutes !== 0)) return null;
  return hours * 60 + minutes;
}

/** A whole number within [min, max], from a form field. */
export function intInRange(raw: unknown, min: number, max: number): number | null {
  // Whatever a number field lets through that is a whole number: "5", "5.0", "1e3", ".5e2" and "0050" too, however many
  // noughts lead it. Never "0x10" or "5.5".
  if (typeof raw !== "string" || !/^-?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/**
 * What the site takes for an email address, wherever one is typed: at
 * sign-in, in a booking, in the admin's forms. It is the rule of the booking's
 * own check (`z.email()` in src/server/bookings.ts), and a test keeps the two
 * in step: an address the browser lets through is never refused by the server.
 */
export const EMAIL_RULE = /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;

/** `EMAIL_RULE` as a field's pattern. A browser reads a pattern with the `v` flag, which wants "-" escaped inside [...]. */
export const EMAIL_PATTERN = String.raw`(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+\-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}`;

/** Attributes for an email field, so the browser refuses before the form is sent what the server would refuse after. */
export const EMAIL_FIELD = {
  type: "email",
  pattern: EMAIL_PATTERN,
  maxLength: 200,
  title: "An email address, for example name@example.com",
} as const;
