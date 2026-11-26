import { eq } from "drizzle-orm";
import { settings as settingsTable } from "@/db/schema";
import type { DbLike } from "@/db/client";
import { TAX_BASIS_POINTS_MAX } from "@/lib/domain/pricing";
import { EMAIL_RULE } from "@/lib/parse";

/**
 * Business rules the owner can change without a deploy. Values in the
 * `settings` table override these defaults. Several defaults are placeholders
 * for decisions that are still open; see "Rebuild decisions" in ProjectLibrary.md.
 */
export interface Settings {
  // ── Booking ──
  /** Start times are offered every N minutes from opening time. */
  slotIncrementMinutes: number;
  /** Bookings must be made at least this many hours ahead. */
  minLeadHours: number;
  /** Bookings can be made at most this many days ahead. */
  maxAdvanceDays: number;
  /**
   * A photography session must be booked at least this many hours ahead. The
   * owner's rule (2026-11-15): the photographer is available from two weeks out.
   */
  photoMinLeadHours: number;
  /**
   * A content creation session is booked at least this many business days ahead, Monday to Friday counted, from the
   * start of the day (the owner's answer of 2026-11-23: "Give content creation 3 businesses days notice period"; question
   * 69 in ProjectLibrary.md). Booked on a Monday, the first day is Thursday; on a Friday or at the weekend, Wednesday.
   */
  contentNoticeBusinessDays: number;
  /** Minutes an unpaid booking keeps its slot while the card is charged. */
  holdMinutes: number;
  /** Discount percent by number of studios booked together: for studios without prices together (`bundle_prices`). */
  multiStudioPercent: Record<number, number>;
  /**
   * The lengths between the listed ones that can be booked, each priced between its two neighbours (`betweenLengths`
   * in pricing.ts): every 30 minutes, every 60, or 0 for the listed lengths only. The owner, 2026-11-25: "any studio
   * and a bundle can be booked for any amount of hours over 1 hour"; how such a length is priced they approved the
   * same day ("OK on prices"; question 83 in ProjectLibrary.md).
   */
  betweenLengthsMinutes: number;
  /**
   * How long every studio and bundle can be booked for, in minutes: the lengths past the longest one listed, at the same
   * steps, are priced on from it (`betweenLengths`). 0: no longer than the longest listed. The owner, 2026-11-25: "Times
   * options should be the same for every studio 1-10 hours".
   */
  longestBookingMinutes: number;
  /**
   * The lengths the booking screen shows as buttons, in minutes; every other length is behind "More". The owner,
   * 2026-11-25: "remove 5 hours so 1, 2, 3, 4, 6 more".
   */
  shownLengthsMinutes: number[];

  // ── Sales tax ──
  /**
   * The sales tax added on top of the prices, in hundredths of a percent: 650 is 6.5%. 0, the default: none, and no tax
   * line anywhere. The owner's decision of 2026-11-20: prices exclude tax, shown as a line of its own at checkout and on
   * receipts, at 6.5% until the accountant confirms the rate and what it applies to (question 84 in ProjectLibrary.md).
   * A booking keeps the rate it was made at.
   */
  salesTaxBasisPoints: number;
  /** What the tax applies to: the studios' time, a session's price (photography, content creation), and add-ons, extra guests and fees. */
  taxStudioTime: boolean;
  taxSessions: boolean;
  taxAddons: boolean;

  // ── Cancelling and moving ──
  /** A cancellation at least this many hours before the start is refunded automatically. */
  refundWindowHours: number;
  /** The same for a photography session, which the photographer has set time aside for. */
  photoRefundWindowHours: number;
  /** Percent of the card payment kept as a processing fee when refunding. */
  refundFeePercent: number;
  /** A customer can ask for a reschedule code until this many hours before the start. */
  rescheduleCutoffHours: number;
  /** How many times the same money can be moved to a new booking free of charge. 0 switches moving off. */
  maxReschedules: number;
  /**
   * What each further move costs, in cents, taken off the reschedule code (the owner's answer of
   * 2026-11-17: $20 for each additional reschedule). 0: after the free ones a booking cannot be moved
   * online again, as before that answer.
   */
  rescheduleFeeCents: number;
  /** Days a reschedule code stays valid. */
  creditValidDays: number;

  /**
   * How many hours before the start the reminder email goes out (the owner's answer of 2026-11-17: 24). 0 sends none.
   * A booking made closer to its start than this gets none: its confirmation has only just been sent.
   */
  reminderHours: number;

  /**
   * How many hours before its start a booking paid with membership minutes can be cancelled with its minutes given
   * back (the owner's answer of 2026-11-18: 48). Later, they are used.
   */
  memberReturnHours: number;

  /**
   * At weekends, a booking paid with membership minutes pays the difference between the weekday and the weekend price
   * of the time the minutes cover (the owners' rule of 2026-11-17). Off, the minutes cover weekend time in full: the
   * default since the owners' answer to question 41 on 2026-11-18 ("only the time balance, not the price").
   */
  memberWeekendDifference: boolean;

  // ── Guests ──
  /**
   * The most guests in all, those included and the extra ones, for two studios booked together, and for all three
   * (the owner's answers of 2026-11-17: 10 and 20, every guest counting). See `extraGuestsAllowed` in pricing.ts.
   */
  twoStudioGuestLimit: number;
  threeStudioGuestLimit: number;

  // ── Loyalty ──
  /** Give one free hour for every `loyaltyVisits` visits. */
  loyaltyEnabled: boolean;
  /** Visits, on separate days, that earn one free hour. */
  loyaltyVisits: number;
  /** Days a free hour stays valid after it is earned. */
  loyaltyValidDays: number;
  /** Hours after a visit ends before it counts as completed. */
  loyaltyDelayHours: number;
  /**
   * When loyalty was last switched on after having been off, as an ISO instant. Stamps are counted from
   * here: visits and changes by hand from before it are left out, and free hours sent before it stay valid
   * (the owner's answer of 2026-11-17). Null while it has never been switched off and on again.
   */
  loyaltyStartedAt: string | null;

  // ── Studio Attendants (the role `staff`): what the owners have switched on for them (see src/lib/abilities.ts) ──
  /** Whether staff see customers' phone number and email. */
  staffSeesContact: boolean;
  /** Whether staff can change the status label of an appointment. */
  staffSetsLabels: boolean;
  /** Whether staff see every day, or only the days assigned to them. */
  staffSeesAllDays: boolean;
  /** Whether staff see what a booking cost. */
  staffSeesPrices: boolean;
  /** Whether staff can move a booking to a new time. */
  staffMovesBookings: boolean;
  /** Whether staff can make a booking for a client. */
  staffCreatesBookings: boolean;
  /** Whether staff can record a payment taken at the studio ("mark as paid"). */
  staffRecordsPayments: boolean;
  /** Whether staff can set the photographer's working hours and block their time. */
  staffSetsPhotographerTimes: boolean;

  // ── Studio Managers: the switches of their own. What running the calendar needs, a manager can always do. ──
  /** Whether managers see what bookings cost, and customers' payments and receipts. */
  managerSeesPrices: boolean;
  /** Whether managers can record a payment taken at the studio and email a payment link. */
  managerRecordsPayments: boolean;
  /** Whether managers can cancel a booking and refund a card payment. */
  managerRefunds: boolean;
  /** Whether managers can open the customers list and a customer's page. */
  managerSeesCustomers: boolean;
  /** Whether managers can correct loyalty stamps and reward statuses. */
  managerCorrectsLoyalty: boolean;
  /** Whether managers can block time in a studio. */
  managerBlocksTime: boolean;
  /** Whether managers can change the website's design and its header, menu and footer, as a draft. */
  managerEditsDesign: boolean;
  /** Whether managers can add and edit the website's pages, as a draft. */
  managerEditsPages: boolean;
  /** Whether managers can publish changes to the website and restore an earlier version. */
  managerPublishesWebsite: boolean;

  // ── Records ──
  /**
   * Years the site keeps the copies of the emails it sent, the sign-in codes it gave and the sign-ins that have
   * ended (the owner's answer of 2026-11-21: 5), and the log of who opened a customer's page with them. Older ones
   * are deleted by the scheduled task (src/server/retention.ts).
   */
  retentionYears: number;
}

export const DEFAULT_SETTINGS: Settings = {
  slotIncrementMinutes: 15,
  minLeadHours: 24,
  maxAdvanceDays: 180,
  photoMinLeadHours: 336, // two weeks, the owner's rule of 2026-11-15
  contentNoticeBusinessDays: 3, // the owner's answer of 2026-11-23
  holdMinutes: 10,
  multiStudioPercent: { 2: 20, 3: 22 },
  betweenLengthsMinutes: 30,
  longestBookingMinutes: 600, // 10 hours, the owner's answer of 2026-11-25
  shownLengthsMinutes: [60, 120, 180, 240, 360], // 1, 2, 3, 4 and 6 hours, the owner's answer of 2026-11-25

  salesTaxBasisPoints: 0, // set by the owners under Settings: 6.5% is their provisional rate (2026-11-20)
  taxStudioTime: true,
  taxSessions: true,
  taxAddons: true,

  refundWindowHours: 168, // 7 days: the owner's answer of 2026-11-17, which changed the 14 days of 2026-11-15
  photoRefundWindowHours: 336, // 14 days, as on the live site and confirmed on 2026-11-17
  refundFeePercent: 5,
  rescheduleCutoffHours: 24,
  maxReschedules: 1,
  rescheduleFeeCents: 2000, // the owner's answer of 2026-11-17: the first reschedule is free, each further one $20
  creditValidDays: 90,

  reminderHours: 24,
  memberReturnHours: 48,
  memberWeekendDifference: false, // question 41, answered 2026-11-18: the hours cover weekend time in full
  twoStudioGuestLimit: 10,
  threeStudioGuestLimit: 20,

  loyaltyEnabled: true,
  loyaltyVisits: 5,
  loyaltyValidDays: 90, // the owner's answer of 2026-11-15 (it was 60)
  loyaltyDelayHours: 2,
  loyaltyStartedAt: null,

  staffSeesContact: true, // the owner's answer of 2026-11-15: shown by default, the switch stays
  staffSetsLabels: true, // the owner, 2026-11-15: "Staff should be able to change all the labels"
  staffSeesAllDays: false,
  staffSeesPrices: false,
  staffMovesBookings: false,
  staffCreatesBookings: false,
  staffRecordsPayments: false,
  staffSetsPhotographerTimes: false,

  // A manager runs the day: taking payments, looking a client up and blocking time are on. What moves money
  // back, changes a client's rewards or shows the studio's income is off until the owners switch it on.
  managerSeesPrices: false,
  managerRecordsPayments: true,
  managerRefunds: false,
  managerSeesCustomers: true,
  managerCorrectsLoyalty: false,
  managerBlocksTime: true,
  // The website is the owners' until they give a manager part of it.
  managerEditsDesign: false,
  managerEditsPages: false,
  managerPublishesWebsite: false,

  retentionYears: 5, // the owner's answer of 2026-11-21
};

const int = ([min, max]: readonly [number, number]) => (v: unknown) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/**
 * The whole numbers the owners set under Settings, each with the lowest and
 * highest it may be. The server keeps to them, and the form gives its fields
 * the same `min` and `max`, so the browser stops a value before it is sent.
 */
export const NUMBER_SETTING_RANGES = {
  slotIncrementMinutes: [5, 240],
  minLeadHours: [0, 24 * 60],
  maxAdvanceDays: [1, 730],
  photoMinLeadHours: [0, 24 * 365],
  contentNoticeBusinessDays: [0, 60],
  holdMinutes: [1, 60],
  refundWindowHours: [0, 24 * 365],
  photoRefundWindowHours: [0, 24 * 365],
  refundFeePercent: [0, 100],
  rescheduleCutoffHours: [0, 24 * 365],
  maxReschedules: [0, 20],
  creditValidDays: [1, 730],
  reminderHours: [0, 24 * 7],
  memberReturnHours: [0, 24 * 30],
  twoStudioGuestLimit: [1, 200],
  threeStudioGuestLimit: [1, 200],
  loyaltyVisits: [1, 100],
  loyaltyValidDays: [1, 730],
  loyaltyDelayHours: [0, 24 * 14],
  retentionYears: [1, 20],
} as const satisfies Partial<Record<keyof Settings, readonly [number, number]>>;

export type NumberSettingKey = keyof typeof NUMBER_SETTING_RANGES;

/**
 * The amounts of money the owners set under Settings, in cents, each with the
 * lowest and highest it may be. The form shows and reads them in dollars.
 */
export const MONEY_SETTING_RANGES = {
  rescheduleFeeCents: [0, 100_000],
} as const satisfies Partial<Record<keyof Settings, readonly [number, number]>>;

export type MoneySettingKey = keyof typeof MONEY_SETTING_RANGES;
const bool = (v: unknown) => typeof v === "boolean";
const instantOrNull = (v: unknown) => v === null || (typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v)));

function discountTable(v: unknown): Record<number, number> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const table: Record<number, number> = {};
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    const count = Number(key);
    if (!Number.isInteger(count) || count < 2 || count > 20) return null;
    if (typeof value !== "number" || !(value >= 0 && value <= 100)) return null;
    table[count] = value;
  }
  return table;
}

/** What `betweenLengthsMinutes` can be: none, every half hour, every hour. */
export const BETWEEN_LENGTHS: readonly number[] = [0, 30, 60];

/** What `longestBookingMinutes` can be: 0 (the longest listed), or 2 to 12 whole hours. */
export const LONGEST_BOOKINGS: readonly number[] = [0, ...Array.from({ length: 11 }, (_, i) => (i + 2) * 60)];

/** The most lengths the booking screen can show before "More". */
export const SHOWN_LENGTHS_MAX = 8;

/** One to `SHOWN_LENGTHS_MAX` different lengths, each a quarter of an hour to a day in quarters of an hour. */
function shownLengthsList(v: unknown): boolean {
  if (!Array.isArray(v) || v.length < 1 || v.length > SHOWN_LENGTHS_MAX) return false;
  return new Set(v).size === v.length && v.every((minutes) => Number.isInteger(minutes) && minutes >= 15 && minutes <= 1440 && minutes % 15 === 0);
}

/** Which values are acceptable for each simple setting. Anything else is ignored. */
const VALIDATORS: { [K in Exclude<keyof Settings, "multiStudioPercent">]: (v: unknown) => boolean } = {
  slotIncrementMinutes: int(NUMBER_SETTING_RANGES.slotIncrementMinutes),
  minLeadHours: int(NUMBER_SETTING_RANGES.minLeadHours),
  maxAdvanceDays: int(NUMBER_SETTING_RANGES.maxAdvanceDays),
  photoMinLeadHours: int(NUMBER_SETTING_RANGES.photoMinLeadHours),
  contentNoticeBusinessDays: int(NUMBER_SETTING_RANGES.contentNoticeBusinessDays),
  holdMinutes: int(NUMBER_SETTING_RANGES.holdMinutes),
  betweenLengthsMinutes: (v) => BETWEEN_LENGTHS.includes(v as number),
  longestBookingMinutes: (v) => LONGEST_BOOKINGS.includes(v as number),
  shownLengthsMinutes: shownLengthsList,
  salesTaxBasisPoints: int([0, TAX_BASIS_POINTS_MAX]),
  taxStudioTime: bool,
  taxSessions: bool,
  taxAddons: bool,
  refundWindowHours: int(NUMBER_SETTING_RANGES.refundWindowHours),
  photoRefundWindowHours: int(NUMBER_SETTING_RANGES.photoRefundWindowHours),
  refundFeePercent: int(NUMBER_SETTING_RANGES.refundFeePercent),
  rescheduleCutoffHours: int(NUMBER_SETTING_RANGES.rescheduleCutoffHours),
  maxReschedules: int(NUMBER_SETTING_RANGES.maxReschedules),
  rescheduleFeeCents: int(MONEY_SETTING_RANGES.rescheduleFeeCents),
  creditValidDays: int(NUMBER_SETTING_RANGES.creditValidDays),
  reminderHours: int(NUMBER_SETTING_RANGES.reminderHours),
  memberReturnHours: int(NUMBER_SETTING_RANGES.memberReturnHours),
  memberWeekendDifference: bool,
  twoStudioGuestLimit: int(NUMBER_SETTING_RANGES.twoStudioGuestLimit),
  threeStudioGuestLimit: int(NUMBER_SETTING_RANGES.threeStudioGuestLimit),
  loyaltyEnabled: bool,
  loyaltyVisits: int(NUMBER_SETTING_RANGES.loyaltyVisits),
  loyaltyValidDays: int(NUMBER_SETTING_RANGES.loyaltyValidDays),
  loyaltyDelayHours: int(NUMBER_SETTING_RANGES.loyaltyDelayHours),
  loyaltyStartedAt: instantOrNull,
  staffSeesContact: bool,
  staffSetsLabels: bool,
  staffSeesAllDays: bool,
  staffSeesPrices: bool,
  staffMovesBookings: bool,
  staffCreatesBookings: bool,
  staffRecordsPayments: bool,
  staffSetsPhotographerTimes: bool,
  managerSeesPrices: bool,
  managerRecordsPayments: bool,
  managerRefunds: bool,
  managerSeesCustomers: bool,
  managerCorrectsLoyalty: bool,
  managerBlocksTime: bool,
  managerEditsDesign: bool,
  managerEditsPages: bool,
  managerPublishesWebsite: bool,
  retentionYears: int(NUMBER_SETTING_RANGES.retentionYears),
};

export type SettingKey = keyof Settings;

/** True when `value` is acceptable for `key`. Used when the owner edits settings. */
function isValidSetting(key: string, value: unknown): key is SettingKey {
  if (key === "multiStudioPercent") return discountTable(value) !== null;
  const check = (VALIDATORS as Record<string, ((v: unknown) => boolean) | undefined>)[key];
  return check !== undefined && check(value);
}

/** Merge stored values over the defaults, ignoring anything malformed. */
function mergeSettings(rows: { key: string; value: unknown }[]): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS, multiStudioPercent: { ...DEFAULT_SETTINGS.multiStudioPercent } };
  for (const { key, value } of rows) {
    if (!isValidSetting(key, value)) continue;
    if (key === "multiStudioPercent") out.multiStudioPercent = discountTable(value)!;
    else (out as unknown as Record<string, unknown>)[key] = value;
  }
  return out;
}

export async function loadSettings(db: DbLike): Promise<Settings> {
  const rows = await db.select().from(settingsTable);
  return mergeSettings(rows);
}

/** Store one setting. Returns false, changing nothing, when the value is not acceptable. */
export async function saveSetting(db: DbLike, key: string, value: unknown): Promise<boolean> {
  if (!isValidSetting(key, value)) return false;
  await db
    .insert(settingsTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value } });
  return true;
}

/**
 * Switch loyalty on or off. Switching it on after it was off starts every
 * customer's stamps over (the owner's answer of 2026-11-17): the moment is
 * kept in `loyaltyStartedAt`, and stamps are counted from it. Free hours
 * already sent are not touched. Saving the switch as it already was changes
 * nothing.
 */
export async function switchLoyalty(db: DbLike, on: boolean, now: Date): Promise<void> {
  const was = (await loadSettings(db)).loyaltyEnabled;
  if (on && !was) await saveSetting(db, "loyaltyStartedAt", now.toISOString());
  await saveSetting(db, "loyaltyEnabled", on);
}

/** The moment stamps are counted from, or null when every visit counts. */
export function loyaltyStart(settings: Pick<Settings, "loyaltyStartedAt">): Date | null {
  return settings.loyaltyStartedAt ? new Date(settings.loyaltyStartedAt) : null;
}

// ── Kept out of `Settings` on purpose ───────────────────────────────────────
// `Settings` travels to every browser inside the catalog. The text below must
// not: it can hold the code for the building door. It lives in the same table
// under a key that `mergeSettings` ignores and `saveSetting` refuses, and is
// only ever read and written through these two functions.

const ACCESS_KEY = "accessInstructions";
export const ACCESS_INSTRUCTIONS_MAX = 1000;

/**
 * How to get into the building, for example the door code and the floor.
 * Given to customers with a confirmed booking only: in the confirmation email
 * and on their booking page. Empty when the owner has not set it.
 */
export async function loadAccessInstructions(db: DbLike): Promise<string> {
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, ACCESS_KEY)).limit(1);
  return typeof row?.value === "string" ? row.value : "";
}

/** Store the text; empty switches it off. Returns false, changing nothing, when it is too long. */
export async function saveAccessInstructions(db: DbLike, text: string): Promise<boolean> {
  const value = text.replace(/\r\n?/g, "\n").trim();
  if (value.length > ACCESS_INSTRUCTIONS_MAX) return false;
  await db
    .insert(settingsTable)
    .values({ key: ACCESS_KEY, value })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value } });
  return true;
}

const CONTACT_INBOX_KEY = "contactInbox";

/**
 * Where the messages of the website's contact form go (the owners' note of 2026-11-22: `hello@`). Empty when the
 * owners have not set it: they then go where the site's notices go (`ownerNotifyEmail`). Kept out of `Settings`, like
 * the getting-in text: no browser needs the studio's inbox.
 */
export async function loadContactInbox(db: DbLike): Promise<string> {
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, CONTACT_INBOX_KEY)).limit(1);
  return typeof row?.value === "string" ? row.value : "";
}

/** Store the address; empty goes back to where the site's notices go. Returns false, changing nothing, for anything but an email address. */
export async function saveContactInbox(db: DbLike, raw: string): Promise<boolean> {
  const value = raw.trim().toLowerCase();
  if (value !== "" && !(value.length <= 200 && EMAIL_RULE.test(value))) return false;
  await db
    .insert(settingsTable)
    .values({ key: CONTACT_INBOX_KEY, value })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value } });
  return true;
}
