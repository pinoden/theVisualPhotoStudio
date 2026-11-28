import type { PromoDays } from "@/lib/domain/promo-days";
import type { PromoKind } from "@/lib/domain/pricing";
import { isIsoDate } from "@/lib/domain/time";
import { EMAIL_RULE, hasPhoneDigits } from "@/lib/parse";

/**
 * A booking in the making, as the booking screen keeps it (the owners' decision of 2026-11-27; the preview test of
 * 2026-11-21, point 12: "The browser's Back button leaves the booking", a refresh started it again).
 *
 * - **Each step is an entry of the browser's history,** marked in the address by what follows `#` (`#step-details`),
 *   which never reaches the server. The browser's Back and Forward buttons then move between the steps, and the
 *   screen's own "← Back" goes through the same entries. The first step gets its mark when the client leaves it, so
 *   `/book` itself stays the address of a booking that has not begun.
 * - **What was chosen and typed is kept in the tab** (`sessionStorage`, which the browser clears with the tab), and
 *   brought back after a refresh, or when the browser returns to the booking from another page. Not the agreement to
 *   the policies, which is given again, nor anything of the card. It is taken away once the booking is made.
 *
 * Plain data and functions, with no browser in them, so that they can be tested by themselves: `BookingFlow.tsx` reads
 * the address and the storage.
 */

export type BookingStep = "studios" | "when" | "details" | "policies" | "pay";
export type BookingMode = "studio" | "time";

/** A code the server accepted for one email address. */
export interface AppliedCode {
  code: string;
  kind: PromoKind;
  value: number;
  photographyOnly?: boolean;
  /** The days a booking with it may be on (question 80); none, any day. */
  days?: PromoDays | null;
  /** Where the code came from: "reschedule" for a moved booking's money. */
  source?: string;
  /**
   * A membership's code (follow-up 3): the minutes left on it, and whether weekends pay the difference. It pays with
   * minutes, never as a discount: `kind` and `value` are not used then.
   */
  membership?: { minutesLeft: number; weekendDifference: boolean; studioIds: string[]; studioNames: string[] };
  email: string;
}

/** What is kept of a booking in the making. */
export interface KeptBooking {
  /** When it was kept, in milliseconds: one older than `KEPT_HOURS` is not brought back. */
  at: number;
  mode: BookingMode;
  studioIds: string[];
  date: string;
  duration: number;
  start: number | null;
  moreLengths: boolean;
  addonCounts: Record<string, number>;
  name: string;
  email: string;
  phone: string;
  notes: string;
  answers: Record<string, string | boolean>;
  codeInput: string;
  applied: AppliedCode | null;
  /** How many entries of the browser's history, right below this one, are earlier steps of this booking. */
  depth: number;
}

/** How long what was kept is brought back: a booking left for longer starts again. */
export const KEPT_HOURS = 12;

/** A step's mark in the address: `#step-details`. */
export const stepHash = (step: BookingStep): string => `#step-${step}`;

/** The step an address marks, as its place in `steps`; -1 when it marks none, or one this path does not have. */
export function stepOfHash(hash: string, steps: readonly BookingStep[]): number {
  const name = /^#step-([a-z]+)$/.exec(hash)?.[1];
  return name ? steps.indexOf(name as BookingStep) : -1;
}

/** Whether anything worth bringing back was chosen or typed. A screen nobody has touched keeps nothing. */
function holdsSomething(kept: Omit<KeptBooking, "at" | "depth">): boolean {
  return (
    kept.studioIds.length > 0 ||
    kept.date !== "" ||
    kept.duration > 0 ||
    kept.start !== null ||
    Object.keys(kept.addonCounts).length > 0 ||
    [kept.name, kept.email, kept.phone, kept.notes, kept.codeInput].some((text) => text.trim() !== "") ||
    Object.keys(kept.answers).length > 0
  );
}

/** What goes into the tab's storage: null when there is nothing to keep, and the entry is then taken away. */
export function keptText(kept: KeptBooking): string | null {
  return holdsSomething(kept) ? JSON.stringify(kept) : null;
}

const isText = (value: unknown): value is string => typeof value === "string";
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * What the tab's storage held, read back. Null for nothing, for text that is not what this screen wrote (another
 * version's, or changed by hand), and for a booking left for longer than `KEPT_HOURS`. Every part is checked: it comes
 * from outside the page.
 */
export function readKept(raw: string | null, now: number): KeptBooking | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { at, mode, studioIds, date, duration, start, moreLengths, addonCounts, name, email, phone, notes, answers, codeInput, applied, depth } = value;
  if (typeof at !== "number" || now - at > KEPT_HOURS * 3_600_000 || at > now + 60_000) return null;
  if (mode !== "studio" && mode !== "time") return null;
  if (!Array.isArray(studioIds) || !studioIds.every(isText)) return null;
  if (!isText(date) || (date !== "" && !isIsoDate(date))) return null;
  if (!isCount(duration) || !(start === null || (isCount(start) && start < 1440))) return null;
  if (typeof moreLengths !== "boolean" || !isCount(depth)) return null;
  if (!isRecord(addonCounts) || !Object.values(addonCounts).every((count) => isCount(count) && count > 0)) return null;
  if (![name, email, phone, notes, codeInput].every(isText)) return null;
  if (!isRecord(answers) || !Object.values(answers).every((answer) => typeof answer === "string" || typeof answer === "boolean")) return null;
  if (!(applied === null || (isRecord(applied) && isText(applied.code) && isText(applied.kind) && typeof applied.value === "number" && isText(applied.email)))) return null;
  const kept = {
    mode: mode as BookingMode,
    studioIds,
    date,
    duration,
    start,
    moreLengths,
    addonCounts: addonCounts as Record<string, number>,
    name: name as string,
    email: email as string,
    phone: phone as string,
    notes: notes as string,
    answers: answers as Record<string, string | boolean>,
    codeInput: codeInput as string,
    applied: applied as AppliedCode | null,
  };
  return holdsSomething(kept) ? { ...kept, at, depth } : null;
}

/**
 * The furthest step that can be shown again with what was kept, up to the one the address marks (`wanted`): every
 * step before it has to be answered. The policies are agreed to again after a refresh, so nothing past them comes
 * back: a refresh on the payment step shows the policies.
 */
export function stepToShowAgain(kept: KeptBooking | null, wanted: number, steps: readonly BookingStep[]): number {
  if (!kept) return 0;
  const answered: Record<BookingStep, boolean> = {
    studios: kept.studioIds.length > 0,
    when: isIsoDate(kept.date) && kept.duration > 0 && kept.start !== null,
    details: kept.name.trim().length >= 2 && EMAIL_RULE.test(kept.email.trim()) && hasPhoneDigits(kept.phone),
    policies: false,
    pay: false,
  };
  let index = 0;
  while (index < wanted && index < steps.length - 1 && answered[steps[index]]) index += 1;
  return index;
}
