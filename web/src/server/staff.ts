import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { bookingAddons, bookings, staffShifts, studioHolds, studios } from "@/db/schema";
import type { DbLike } from "@/db/client";
import { labelOf, type LabelKey } from "@/lib/domain/labels";
import { isIsoDate, type IsoDate } from "@/lib/domain/time";
import type { AuthUser } from "./auth";
import { loadSettings } from "./settings";
import { dayBoundsUtc, formatRange } from "./tz";

/**
 * What staff may see: the bookings of the days the owner assigned to them,
 * or of every day when the owner has switched that on. No revenue and no
 * customer list. These functions are the only way the day sheet reads
 * bookings, and each one checks the viewer itself. What staff may do with an
 * appointment is in `appointments.ts`.
 */
export interface DaySheetEntry {
  ref: string;
  time: string;
  startAt: string;
  studios: string[];
  customerName: string;
  /** Present only for the owner, or when the owner allows staff to see contact details. */
  customerPhone: string | null;
  customerEmail: string | null;
  addons: { name: string; quantity: number }[];
  notes: string;
  status: "confirmed" | "completed" | "no_show";
  /** The status label shown for it. */
  label: LabelKey;
}

/** Dates from `from` on that a staff member is assigned to. */
export async function listShiftDays(db: DbLike, userId: string, from: IsoDate): Promise<IsoDate[]> {
  const rows = await db
    .select({ day: staffShifts.day })
    .from(staffShifts)
    .where(and(eq(staffShifts.userId, userId), gte(staffShifts.day, from)))
    .orderBy(asc(staffShifts.day));
  return rows.map((r) => r.day);
}

export async function canViewDay(db: DbLike, viewer: AuthUser, date: string): Promise<boolean> {
  if (!isIsoDate(date)) return false;
  if (viewer.role === "owner") return true;
  if (viewer.role !== "staff") return false;
  if ((await loadSettings(db)).staffSeesAllDays) return true;
  const rows = await db
    .select({ day: staffShifts.day })
    .from(staffShifts)
    .where(and(eq(staffShifts.userId, viewer.id), eq(staffShifts.day, date)))
    .limit(1);
  return rows.length > 0;
}

export type DaySheetResult =
  | { ok: true; date: IsoDate; entries: DaySheetEntry[] }
  | { ok: false; reason: "forbidden" | "invalid_date" };

/** The bookings of one studio-local day, for someone allowed to see that day. */
export async function getDaySheet(db: DbLike, viewer: AuthUser, date: string): Promise<DaySheetResult> {
  if (!isIsoDate(date)) return { ok: false, reason: "invalid_date" };
  if (!(await canViewDay(db, viewer, date))) return { ok: false, reason: "forbidden" };

  const settings = await loadSettings(db);
  const showContact = viewer.role === "owner" || settings.staffSeesContact;
  const { start, end } = dayBoundsUtc(date);
  const rows = await db
    .select()
    .from(bookings)
    .where(
      and(
        gte(bookings.startAt, start),
        lt(bookings.startAt, end),
        inArray(bookings.status, ["confirmed", "completed", "no_show"]),
      ),
    )
    .orderBy(asc(bookings.startAt));
  if (rows.length === 0) return { ok: true, date, entries: [] };

  const ids = rows.map((r) => r.id);
  const [studioRows, addonRows] = await Promise.all([
    db
      .select({ bookingId: studioHolds.bookingId, name: studios.name, sort: studios.sortOrder })
      .from(studioHolds)
      .innerJoin(studios, eq(studios.id, studioHolds.studioId))
      .where(inArray(studioHolds.bookingId, ids)),
    db.select().from(bookingAddons).where(inArray(bookingAddons.bookingId, ids)),
  ]);

  return {
    ok: true,
    date,
    entries: rows.map((b) => ({
      ref: b.ref,
      time: formatRange(b.startAt, b.endAt).time,
      startAt: b.startAt.toISOString(),
      studios: studioRows
        .filter((s) => s.bookingId === b.id)
        .sort((x, y) => x.sort - y.sort)
        .map((s) => s.name),
      customerName: b.customerName,
      customerPhone: showContact ? b.customerPhone : null,
      customerEmail: showContact ? b.customerEmail : null,
      addons: addonRows.filter((a) => a.bookingId === b.id).map((a) => ({ name: a.name, quantity: a.quantity })),
      notes: b.notes,
      status: b.status as DaySheetEntry["status"],
      label: labelOf(b),
    })),
  };
}
