/** Reading what people type into forms. Each returns null for anything it does not understand. */

/** "88", "88.5", "$1,500.00" -> cents. Never uses floating point. */
export function dollarsToCents(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
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
  if (typeof raw !== "string" || !/^-?\d{1,9}$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return value >= min && value <= max ? value : null;
}
