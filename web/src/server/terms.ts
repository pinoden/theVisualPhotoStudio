import { MONEY_SETTING_RANGES, NUMBER_SETTING_RANGES, type Settings } from "./settings";

/**
 * The terms a booking is made under, kept with it (`bookings.terms`): a booking keeps the policies in effect when it
 * was made, and terms changed later apply only to bookings made afterwards (the owner's answer of 2026-11-17,
 * question 10). A cancellation, a move and the credit they give read them from the booking, never from the settings
 * of the day.
 *
 * `refundWindowHours` is the window that applies to this booking: a photography session's own
 * (`photoRefundWindowHours`) for a session, as it was when the session was booked.
 */
export interface BookingTerms {
  refundWindowHours: number;
  refundFeePercent: number;
  rescheduleCutoffHours: number;
  /** Whether a late cancellation gets a credit code, and until how many hours before the start (`Settings.cancelCode*`). */
  cancelCodeEnabled: boolean;
  cancelCodeUntilHours: number;
  maxReschedules: number;
  rescheduleFeeCents: number;
  creditValidDays: number;
  /** How long before its start a booking paid with membership minutes is cancelled with its minutes given back. */
  memberReturnHours: number;
  /** Whether the code or credit it was made with comes back when its client cancels and the terms refund nothing (`Settings.lateCancelKeepsCode`). */
  lateCancelKeepsCode: boolean;
  /** Whether the code it is released for is for weekdays only when it was booked for one (`Settings.weekdayCodeOnWeekdays`). */
  weekdayCodeOnWeekdays: boolean;
}

/** The terms that are switches. A booking made before one was kept follows the setting of the day, like one made before any terms were. */
const SWITCHES = ["lateCancelKeepsCode", "weekdayCodeOnWeekdays", "cancelCodeEnabled"] as const satisfies readonly (keyof BookingTerms)[];
/** The terms that are numbers, each within its setting's range. */
type NumberTerm = Exclude<keyof BookingTerms, (typeof SWITCHES)[number]>;

const RANGES: Record<NumberTerm, readonly [number, number]> = {
  refundWindowHours: NUMBER_SETTING_RANGES.refundWindowHours,
  refundFeePercent: NUMBER_SETTING_RANGES.refundFeePercent,
  rescheduleCutoffHours: NUMBER_SETTING_RANGES.rescheduleCutoffHours,
  cancelCodeUntilHours: NUMBER_SETTING_RANGES.cancelCodeUntilHours,
  maxReschedules: NUMBER_SETTING_RANGES.maxReschedules,
  rescheduleFeeCents: MONEY_SETTING_RANGES.rescheduleFeeCents,
  creditValidDays: NUMBER_SETTING_RANGES.creditValidDays,
  memberReturnHours: NUMBER_SETTING_RANGES.memberReturnHours,
};

const KEYS = Object.keys(RANGES) as NumberTerm[];

/** The terms a booking made now takes: the settings of this moment, with a session's own refund window. */
export function termsAtBooking(settings: Settings, photography: boolean): BookingTerms {
  return {
    refundWindowHours: photography ? settings.photoRefundWindowHours : settings.refundWindowHours,
    refundFeePercent: settings.refundFeePercent,
    rescheduleCutoffHours: settings.rescheduleCutoffHours,
    cancelCodeEnabled: settings.cancelCodeEnabled,
    cancelCodeUntilHours: settings.cancelCodeUntilHours,
    maxReschedules: settings.maxReschedules,
    rescheduleFeeCents: settings.rescheduleFeeCents,
    creditValidDays: settings.creditValidDays,
    memberReturnHours: settings.memberReturnHours,
    lateCancelKeepsCode: settings.lateCancelKeepsCode,
    weekdayCodeOnWeekdays: settings.weekdayCodeOnWeekdays,
  };
}

/**
 * The terms kept with a booking, read back. A booking made before terms were kept (none yet on 2026-11-18, when this
 * was built, was a real one) has none: it follows the settings of the day, as every booking did until then. A value
 * that is not a whole number within its setting's range is taken from the settings as well.
 */
export function storedTerms(booking: { photographerId: string | null; terms: unknown }, settings: Settings): BookingTerms {
  const now = termsAtBooking(settings, booking.photographerId !== null);
  const stored = booking.terms !== null && typeof booking.terms === "object" ? (booking.terms as Record<string, unknown>) : {};
  const terms = { ...now };
  for (const key of KEYS) {
    const value = stored[key];
    const [min, max] = RANGES[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) terms[key] = value;
  }
  for (const key of SWITCHES) {
    const value = stored[key];
    if (typeof value === "boolean") terms[key] = value;
  }
  return terms;
}

/**
 * The settings as they apply to one booking: today's, with the terms it was made under in their place. What reads a
 * booking's refund, move or credit takes this rather than the settings themselves.
 */
export function termsFor(booking: { photographerId: string | null; terms: unknown }, settings: Settings): Settings {
  return { ...settings, ...storedTerms(booking, settings) };
}

/** True when the booking's terms are not those a booking made now would take: the owners changed them since. */
export function termsChangedSince(booking: { photographerId: string | null; terms: unknown }, settings: Settings): boolean {
  const kept = storedTerms(booking, settings);
  const now = termsAtBooking(settings, booking.photographerId !== null);
  return [...KEYS, ...SWITCHES].some((key) => kept[key] !== now[key]);
}
