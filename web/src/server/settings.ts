import { eq } from "drizzle-orm";
import { settings as settingsTable } from "@/db/schema";
import type { DbLike } from "@/db/client";

/**
 * Business rules the owner can change without a deploy. Values in the
 * `settings` table override these defaults. Several defaults are placeholders
 * for decisions that are still open; see "Rebuild decisions" in CLAUDE.md.
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
  /** Minutes an unpaid booking keeps its slot while the card is charged. */
  holdMinutes: number;
  /** Discount percent by number of studios booked together. */
  multiStudioPercent: Record<number, number>;

  // ── Cancelling and moving ──
  /** A cancellation at least this many hours before the start is refunded automatically. */
  refundWindowHours: number;
  /** The same for a photography session, which the photographer has set time aside for. */
  photoRefundWindowHours: number;
  /** Percent of the card payment kept as a processing fee when refunding. */
  refundFeePercent: number;
  /** A customer can ask for a reschedule code until this many hours before the start. */
  rescheduleCutoffHours: number;
  /** How many times the same money can be moved to a new booking. */
  maxReschedules: number;
  /** Days a reschedule code stays valid. */
  creditValidDays: number;

  // ── Loyalty ──
  /** Give one free hour for every `loyaltyVisits` visits. */
  loyaltyEnabled: boolean;
  /** Visits, on separate days, that earn one free hour. */
  loyaltyVisits: number;
  /** Days a free hour stays valid after it is earned. */
  loyaltyValidDays: number;
  /** Hours after a visit ends before it counts as completed. */
  loyaltyDelayHours: number;

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
}

export const DEFAULT_SETTINGS: Settings = {
  slotIncrementMinutes: 15,
  minLeadHours: 24,
  maxAdvanceDays: 180,
  photoMinLeadHours: 336, // two weeks, the owner's rule of 2026-11-15
  holdMinutes: 10,
  multiStudioPercent: { 2: 20, 3: 22 },

  refundWindowHours: 336, // 14 days: the owner's answer of 2026-11-15 (it was 7 days)
  photoRefundWindowHours: 336, // 14 days, as on the live site
  refundFeePercent: 5,
  rescheduleCutoffHours: 24,
  maxReschedules: 1,
  creditValidDays: 90,

  loyaltyEnabled: true,
  loyaltyVisits: 5,
  loyaltyValidDays: 90, // the owner's answer of 2026-11-15 (it was 60)
  loyaltyDelayHours: 2,

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
};

const int = (min: number, max: number) => (v: unknown) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const bool = (v: unknown) => typeof v === "boolean";

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

/** Which values are acceptable for each simple setting. Anything else is ignored. */
const VALIDATORS: { [K in Exclude<keyof Settings, "multiStudioPercent">]: (v: unknown) => boolean } = {
  slotIncrementMinutes: int(5, 240),
  minLeadHours: int(0, 24 * 60),
  maxAdvanceDays: int(1, 730),
  photoMinLeadHours: int(0, 24 * 365),
  holdMinutes: int(1, 60),
  refundWindowHours: int(0, 24 * 365),
  photoRefundWindowHours: int(0, 24 * 365),
  refundFeePercent: int(0, 100),
  rescheduleCutoffHours: int(0, 24 * 365),
  maxReschedules: int(0, 20),
  creditValidDays: int(1, 730),
  loyaltyEnabled: bool,
  loyaltyVisits: int(1, 100),
  loyaltyValidDays: int(1, 730),
  loyaltyDelayHours: int(0, 24 * 14),
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
};

export type SettingKey = keyof Settings;
export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as SettingKey[];

/** True when `value` is acceptable for `key`. Used when the owner edits settings. */
export function isValidSetting(key: string, value: unknown): key is SettingKey {
  if (key === "multiStudioPercent") return discountTable(value) !== null;
  const check = (VALIDATORS as Record<string, ((v: unknown) => boolean) | undefined>)[key];
  return check !== undefined && check(value);
}

/** Merge stored values over the defaults, ignoring anything malformed. */
export function mergeSettings(rows: { key: string; value: unknown }[]): Settings {
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
