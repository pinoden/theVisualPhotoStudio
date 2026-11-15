import { and, asc, eq, lt, sql } from "drizzle-orm";
import { bookings, photographerHours, photographers } from "@/db/schema";
import { queryRows, type DbLike } from "@/db/client";
import type { StudioDay } from "@/lib/domain/availability";
import { daysBetween, isIsoDate, isoWeekday, type DayType, type IsoDate } from "@/lib/domain/time";
import { dayTypeFor, type Catalog } from "./catalog";
import { releaseHolds } from "./holds";
import { dayBoundsUtc, localDateOf, localMinuteOn, localMinuteOnFloor } from "./tz";

/**
 * Free the slots of bookings whose payment never completed. Runs before every
 * availability read and every booking attempt, so no scheduler is needed.
 */
export async function releaseExpiredHolds(db: DbLike, now: Date): Promise<number> {
  const expired = await db
    .update(bookings)
    .set({ status: "expired" })
    .where(and(eq(bookings.status, "pending_payment"), lt(bookings.holdExpiresAt, now)))
    .returning({ id: bookings.id });
  if (expired.length === 0) return 0;
  await releaseHolds(
    db,
    expired.map((b) => b.id),
  );
  return expired.length;
}

export type WindowProblem = "invalid_date" | "past" | "too_far";

export interface DayAvailability {
  date: IsoDate;
  dayType: DayType;
  /** Set when nothing on this date can be booked at all. */
  problem: WindowProblem | null;
  /** Starts earlier than this minute are inside the minimum notice period. */
  earliestStartMinute: number;
  days: StudioDay[];
  /**
   * The photographer's day, when it was asked for: the hours they work and
   * the time they are taken. Its `studioId` is the photographer's id. Null
   * when there is no photographer to book.
   */
  photographer?: StudioDay | null;
}

/** Which dates can be booked right now, and from what time on the first day. */
export function bookingWindow(
  date: string,
  now: Date,
  settings: Catalog["settings"],
): { problem: WindowProblem | null; earliestStartMinute: number } {
  if (!isIsoDate(date)) return { problem: "invalid_date", earliestStartMinute: 1440 };
  const today = localDateOf(now);
  if (date < today) return { problem: "past", earliestStartMinute: 1440 };
  if (daysBetween(today, date) > settings.maxAdvanceDays) return { problem: "too_far", earliestStartMinute: 1440 };
  const earliest = new Date(now.getTime() + settings.minLeadHours * 3_600_000);
  return { problem: null, earliestStartMinute: localMinuteOn(earliest, date) };
}

export interface AvailabilityOptions {
  /** Leave this booking's own holds out. For moving it: its present time does not stand in its own way. */
  excludeBookingId?: string;
  /**
   * An administrator is booking or moving. The notice period that customers
   * have to give does not apply: any time from now on can be chosen. Opening
   * hours, existing bookings and the gap between them apply as for anyone.
   */
  asAdmin?: boolean;
  /** Also report the photographer's day: for a photography session, which needs both the studio and the photographer. */
  withPhotographer?: boolean;
}

/**
 * The hours the photographer works on a date, and the time they are already
 * taken: by sessions, in whatever studio, and by time blocked in the admin.
 */
async function loadPhotographerDay(
  db: DbLike,
  catalog: Catalog,
  date: IsoDate,
  excludeBookingId: string | null,
): Promise<StudioDay | null> {
  const [person] = await db
    .select({ id: photographers.id })
    .from(photographers)
    .where(eq(photographers.active, true))
    .orderBy(asc(photographers.sortOrder), asc(photographers.name))
    .limit(1);
  if (!person) return null;
  const [hours] = await db
    .select()
    .from(photographerHours)
    .where(and(eq(photographerHours.photographerId, person.id), eq(photographerHours.weekday, isoWeekday(date))))
    .limit(1);

  const { start, end } = dayBoundsUtc(date);
  const holds = await queryRows<{ start_at: string | Date; end_at: string | Date }>(
    db,
    sql`
      select lower(occupied) as start_at, upper(occupied) as end_at
      from photographer_holds
      where active
        and photographer_id = ${person.id}
        and occupied && tstzrange(${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz, '[)')
        and (${excludeBookingId}::uuid is null or booking_id is distinct from ${excludeBookingId}::uuid)
    `,
  );
  return {
    studioId: person.id,
    openMinute: hours ? hours.openMinute : null,
    closeMinute: hours ? hours.closeMinute : null,
    // Between two sessions the photographer keeps the gap the studios keep between bookings.
    bufferMinutes: Math.max(0, ...catalog.studios.map((studio) => studio.bufferMinutes)),
    busy: holds
      .map((hold) => ({
        start: localMinuteOnFloor(new Date(hold.start_at), date),
        end: localMinuteOn(new Date(hold.end_at), date),
      }))
      .filter((span) => span.end > span.start)
      .sort((a, b) => a.start - b.start),
    anyStart: true,
  };
}

/** Opening hours and taken time for every active studio on one date. */
export async function loadDayAvailability(
  db: DbLike,
  catalog: Catalog,
  date: string,
  now: Date,
  options: AvailabilityOptions = {},
): Promise<DayAvailability> {
  const window = bookingWindow(date, now, options.asAdmin ? { ...catalog.settings, minLeadHours: 0 } : catalog.settings);
  const exclude = options.excludeBookingId ?? null;
  if (window.problem === "invalid_date") {
    return { date, dayType: "weekday", problem: window.problem, earliestStartMinute: 1440, days: [] };
  }

  const { start, end } = dayBoundsUtc(date);
  const holds = await queryRows<{ studio_id: string; start_at: string | Date; end_at: string | Date }>(
    db,
    sql`
      select studio_id, lower(occupied) as start_at, upper(occupied) as end_at
      from studio_holds
      where active
        and occupied && tstzrange(${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz, '[)')
        and (${exclude}::uuid is null or booking_id is distinct from ${exclude}::uuid)
    `,
  );

  const weekday = isoWeekday(date);
  const days: StudioDay[] = catalog.studios.map((studio) => {
    const hours = studio.hours[weekday];
    return {
      studioId: studio.id,
      openMinute: hours ? hours.openMinute : null,
      closeMinute: hours ? hours.closeMinute : null,
      bufferMinutes: studio.bufferMinutes,
      busy: holds
        .filter((hold) => hold.studio_id === studio.id)
        .map((hold) => ({
          start: localMinuteOnFloor(new Date(hold.start_at), date),
          end: localMinuteOn(new Date(hold.end_at), date),
        }))
        .filter((span) => span.end > span.start),
    };
  });

  return {
    date,
    dayType: dayTypeFor(catalog, date),
    problem: window.problem,
    earliestStartMinute: window.earliestStartMinute,
    days,
    ...(options.withPhotographer ? { photographer: await loadPhotographerDay(db, catalog, date, exclude) } : {}),
  };
}
