import { and, asc, eq, sql } from "drizzle-orm";
import { bookings, photographerHours, photographers, studioHolds } from "@/db/schema";
import { queryRows, type DbLike } from "@/db/client";
import { SERVICE_WORDS, type Service } from "@/lib/domain/services";
import { isIsoDate, isoWeekday, minutesToLabel, weekdayName, type IsoDate } from "@/lib/domain/time";
import type { AuthUser } from "./auth";
import { sessionServiceOf } from "./availability";
import { loadCatalog, type Catalog } from "./catalog";
import { dayBoundsUtc, localDateOf, localMinuteOn, localMinuteOnFloor, localToUtc } from "./tz";

// A booking's ref, as `isBookingRef` in bookings.ts reads it (bookings.ts imports this file).
const isBookingRef = (value: string) => /^VS-[0-9A-Z]{6}$/.test(value);

/**
 * An owner's override (the owner's answers of 2026-11-23: "Only admin may override", and "if owner==admin makes changes
 * manually, it should be able to work. If it overrides or something like that, you just bring a pop up notification, but
 * if they press "OK" the appointments can override"; question 79 in ProjectLibrary.md).
 *
 * When an owner books, moves or changes a booking, a time is not refused for what is in its way: the studio's opening
 * hours, another booking (with the gap after it), blocked time, and for a session its person's working hours, sessions
 * and days off. Each is a `Conflict`, listed in a pop-up before anything is saved; only "OK" saves it, and the server
 * checks again that nothing has come in the way since the owner read the list (`overrideRefusal`). A booking saved over
 * another's time is let through by the database (`overlap_allowed` on its holds, migration 0066); nobody else's booking
 * can then take that time, as the site still counts it taken.
 *
 * What is not passed over: a time already gone, a date beyond the bookings' horizon, the hour the clocks change, a price
 * that does not exist, and props (each prop is one thing).
 */
export interface Conflict {
  /** Names the thing in the way, the same in the pop-up and when the change is saved: `hours:<studio>`, `hold:<id>`, `person-hours`, `person-hold:<id>`. */
  key: string;
  text: string;
  /** Where it overlaps a hold (a studio's, or the session's person's), the hold that may then overlap: a studio's id, or "person". */
  overlaps: string | null;
}

interface HeldSpan {
  id: string;
  start: number;
  end: number;
  /** For a booking: its client's name, its ref, and its own time (without the gap). */
  booking: { name: string; ref: string; start: number; end: number } | null;
  note: string;
}

interface StudioPlan {
  id: string;
  name: string;
  hours: { openMinute: number; closeMinute: number } | null;
  bufferMinutes: number;
  held: HeldSpan[];
}

interface PersonPlan {
  service: Service;
  hours: { openMinute: number; closeMinute: number } | null;
  bufferMinutes: number;
  held: HeldSpan[];
}

/** What stands on a date: each studio's hours and what holds it, and the session's person's day. */
export interface OverrideDay {
  date: IsoDate;
  studios: StudioPlan[];
  person: PersonPlan | null;
}

type HoldRow = {
  id: string;
  owner_id: string;
  start_at: string | Date;
  end_at: string | Date;
  booking_ref: string | null;
  customer_name: string | null;
  booking_start: string | Date | null;
  booking_end: string | Date | null;
  note: string | null;
};

function spans(rows: HoldRow[], date: IsoDate): (HeldSpan & { ownerId: string })[] {
  return rows
    .map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      start: localMinuteOnFloor(new Date(row.start_at), date),
      end: localMinuteOn(new Date(row.end_at), date),
      booking:
        row.booking_ref && row.booking_start && row.booking_end
          ? {
              name: row.customer_name ?? "",
              ref: row.booking_ref,
              start: localMinuteOnFloor(new Date(row.booking_start), date),
              end: localMinuteOn(new Date(row.booking_end), date),
            }
          : null,
      note: row.note ?? "",
    }))
    .filter((span) => span.end > span.start);
}

export async function loadOverrideDay(
  db: DbLike,
  catalog: Catalog,
  selection: { date: IsoDate; studioIds: string[]; excludeBookingId?: string | null; service?: Service | null },
): Promise<OverrideDay> {
  const { date } = selection;
  const exclude = selection.excludeBookingId ?? null;
  const { start, end } = dayBoundsUtc(date);
  const range = sql`tstzrange(${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz, '[)')`;
  const studioRows = await queryRows<HoldRow>(
    db,
    sql`
      select h.id, h.studio_id as owner_id, lower(h.occupied) as start_at, upper(h.occupied) as end_at,
             b.ref as booking_ref, b.customer_name, b.start_at as booking_start, b.end_at as booking_end, bl.note
      from studio_holds h
      left join bookings b on b.id = h.booking_id
      left join blocks bl on bl.id = h.block_id
      where h.active and h.occupied && ${range}
        and (${exclude}::uuid is null or h.booking_id is distinct from ${exclude}::uuid)
      order by lower(h.occupied)
    `,
  );
  const held = spans(studioRows, date);
  const weekday = isoWeekday(date);
  const studios = catalog.studios
    .filter((studio) => selection.studioIds.includes(studio.id))
    .map((studio) => ({
      id: studio.id,
      name: studio.name,
      hours: studio.hours[weekday] ?? null,
      bufferMinutes: studio.bufferMinutes,
      held: held.filter((span) => span.ownerId === studio.id),
    }));

  let person: PersonPlan | null = null;
  if (selection.service) {
    const [found] = await db
      .select({ id: photographers.id })
      .from(photographers)
      .where(and(eq(photographers.active, true), eq(photographers.service, selection.service)))
      .orderBy(asc(photographers.sortOrder), asc(photographers.name))
      .limit(1);
    if (found) {
      const [hours] = await db
        .select()
        .from(photographerHours)
        .where(and(eq(photographerHours.photographerId, found.id), eq(photographerHours.weekday, weekday)))
        .limit(1);
      const personRows = await queryRows<HoldRow>(
        db,
        sql`
          select h.id, h.photographer_id as owner_id, lower(h.occupied) as start_at, upper(h.occupied) as end_at,
                 b.ref as booking_ref, b.customer_name, b.start_at as booking_start, b.end_at as booking_end, h.note
          from photographer_holds h
          left join bookings b on b.id = h.booking_id
          where h.active and h.photographer_id = ${found.id} and h.occupied && ${range}
            and (${exclude}::uuid is null or h.booking_id is distinct from ${exclude}::uuid)
          order by lower(h.occupied)
        `,
      );
      person = {
        service: selection.service,
        hours: hours ? { openMinute: hours.openMinute, closeMinute: hours.closeMinute } : null,
        bufferMinutes: Math.max(0, ...catalog.studios.map((studio) => studio.bufferMinutes)),
        held: spans(personRows, date),
      };
    }
  }
  return { date, studios, person };
}

const span = (start: number, end: number) => `${minutesToLabel(start)}–${minutesToLabel(Math.min(end, 1440))}`;

function heldText(where: string, hold: HeldSpan): string {
  if (hold.booking) {
    return `${where}: ${hold.booking.name ? `${hold.booking.name}’s booking` : "a booking"} (${hold.booking.ref}), ${span(hold.booking.start, hold.booking.end)}, and the gap after it`;
  }
  return `${where}: blocked ${span(hold.start, hold.end)}${hold.note ? ` (${hold.note})` : ""}`;
}

/** What a time on the day passes over: nothing when it is free. */
export function conflictsAt(day: OverrideDay, startMinute: number, durationMinutes: number): Conflict[] {
  const end = startMinute + durationMinutes;
  const weekday = weekdayName(isoWeekday(day.date));
  const found: Conflict[] = [];
  for (const studio of day.studios) {
    if (!studio.hours) found.push({ key: `hours:${studio.id}`, text: `${studio.name} is closed on ${weekday}s`, overlaps: null });
    else if (startMinute < studio.hours.openMinute || end > studio.hours.closeMinute) {
      found.push({ key: `hours:${studio.id}`, text: `${studio.name} is open ${span(studio.hours.openMinute, studio.hours.closeMinute)} on ${weekday}s`, overlaps: null });
    }
    const occupiedEnd = end + studio.bufferMinutes;
    for (const hold of studio.held) {
      if (startMinute < hold.end && hold.start < occupiedEnd) found.push({ key: `hold:${hold.id}`, text: heldText(studio.name, hold), overlaps: studio.id });
    }
  }
  const person = day.person;
  if (person) {
    const who = SERVICE_WORDS[person.service].person;
    const The = `${who.charAt(0).toUpperCase()}${who.slice(1)}`;
    if (!person.hours) found.push({ key: "person-hours", text: `The ${who} does not work on ${weekday}s`, overlaps: null });
    else if (startMinute < person.hours.openMinute || end > person.hours.closeMinute) {
      found.push({ key: "person-hours", text: `The ${who} works ${span(person.hours.openMinute, person.hours.closeMinute)} on ${weekday}s`, overlaps: null });
    }
    const heldUntil = end + person.bufferMinutes;
    for (const hold of person.held) {
      if (!(startMinute < hold.end && hold.start < heldUntil)) continue;
      found.push({
        key: `person-hold:${hold.id}`,
        text: hold.booking
          ? `${The}: ${hold.booking.name ? `${hold.booking.name}’s session` : "a session"} (${hold.booking.ref}), ${span(hold.booking.start, hold.booking.end)}`
          : `${The}: time off, ${span(hold.start, hold.end)}${hold.note ? ` (${hold.note})` : ""}`,
        overlaps: "person",
      });
    }
  }
  return found;
}

/** Whether a time on the date lasts as long as it says: not across the hour the clocks change. */
function lastsItsLength(date: IsoDate, startMinute: number, durationMinutes: number): boolean {
  if (startMinute + durationMinutes > 1440) return false;
  return localToUtc(date, startMinute + durationMinutes).getTime() - localToUtc(date, startMinute).getTime() === durationMinutes * 60_000;
}

/** Every start an owner may choose on the day, from `earliestStartMinute`, each with what it passes over. */
export function everyStart(
  day: OverrideDay,
  options: { durationMinutes: number; incrementMinutes: number; earliestStartMinute: number },
): { minute: number; conflicts: Conflict[] }[] {
  const starts: { minute: number; conflicts: Conflict[] }[] = [];
  const step = Math.max(1, options.incrementMinutes);
  const first = Math.ceil(Math.max(0, options.earliestStartMinute) / step) * step;
  for (let minute = first; minute + options.durationMinutes <= 1440; minute += step) {
    if (!lastsItsLength(day.date, minute, options.durationMinutes)) continue;
    starts.push({ minute, conflicts: conflictsAt(day, minute, options.durationMinutes) });
  }
  return starts;
}

/**
 * Null when every conflict found now was among those the owner confirmed; otherwise what to tell them. Something that
 * came in the way after the pop-up was read is not passed over without being read.
 */
export function overrideRefusal(conflicts: Conflict[], confirmed: readonly string[]): string | null {
  const unread = conflicts.filter((conflict) => !confirmed.includes(conflict.key));
  if (unread.length === 0) return null;
  return `That time passes over ${unread.map((conflict) => conflict.text).join("; ")}. Choose it again to read what it passes over, and press OK to go ahead.`;
}

/** The holds a saved override lets overlap: those of the studios (by id) and of the person ("person") something overlaps. */
export const overlapping = (conflicts: Conflict[]) => new Set(conflicts.flatMap((conflict) => (conflict.overlaps ? [conflict.overlaps] : [])));

/** The confirmed keys, as the pop-up sends them: one field, keys apart by spaces. Null when no pop-up was confirmed. */
export function confirmedKeys(value: FormDataEntryValue | null): string[] | null {
  if (typeof value !== "string") return null;
  return value
    .split(/\s+/)
    .filter((key) => /^(hours:|hold:|person-hold:)[0-9a-f-]{36}$|^person-hours$/.test(key))
    .slice(0, 200);
}

/** What a time passes over, for the pop-up: for an owner only (anyone else's time is checked as free, or refused). */
export async function conflictsFor(
  db: DbLike,
  viewer: AuthUser,
  selection: { studioIds: string[]; date: string; startMinute: number; durationMinutes: number; excludeBookingId?: string | null; service?: Service | null },
): Promise<Conflict[]> {
  if (viewer.role !== "owner" || !isIsoDate(selection.date)) return [];
  const { startMinute, durationMinutes } = selection;
  if (!Number.isInteger(startMinute) || !Number.isInteger(durationMinutes) || startMinute < 0 || durationMinutes <= 0 || startMinute + durationMinutes > 1440) return [];
  const catalog = await loadCatalog(db);
  const day = await loadOverrideDay(db, catalog, { ...selection, date: selection.date });
  return conflictsAt(day, startMinute, durationMinutes);
}

/** The booking a move or a change is of: its studios, its session's person, its day and start. */
async function bookingPlan(db: DbLike, ref: string) {
  if (!isBookingRef(ref)) return null;
  const [booking] = await db.select().from(bookings).where(eq(bookings.ref, ref)).limit(1);
  if (!booking) return null;
  const held = await db.select({ studioId: studioHolds.studioId }).from(studioHolds).where(eq(studioHolds.bookingId, booking.id));
  const date = localDateOf(booking.startAt);
  return {
    booking,
    studioIds: held.map((row) => row.studioId),
    service: (await sessionServiceOf(db, booking.photographerId)) || null,
    date,
    startMinute: localMinuteOn(booking.startAt, date),
  };
}

/** What moving a booking to a new time passes over. */
export async function moveConflicts(db: DbLike, viewer: AuthUser, ref: string, date: string, startMinute: number): Promise<Conflict[]> {
  const plan = viewer.role === "owner" ? await bookingPlan(db, ref) : null;
  if (!plan) return [];
  return conflictsFor(db, viewer, { studioIds: plan.studioIds, date, startMinute, durationMinutes: plan.booking.durationMinutes, excludeBookingId: plan.booking.id, service: plan.service });
}

/** What changing a booking's studios and length, at its own start, passes over. */
export async function changeConflicts(db: DbLike, viewer: AuthUser, ref: string, change: { studioIds: string[]; durationMinutes: number }): Promise<Conflict[]> {
  const plan = viewer.role === "owner" ? await bookingPlan(db, ref) : null;
  if (!plan) return [];
  return conflictsFor(db, viewer, { studioIds: [...new Set(change.studioIds)], date: plan.date, startMinute: plan.startMinute, durationMinutes: change.durationMinutes, excludeBookingId: plan.booking.id });
}
