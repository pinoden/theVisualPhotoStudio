import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { bookings, photoPackages, photographerHolds, photographerHours, photographers, studios } from "@/db/schema";
import { PG_EXCLUSION_VIOLATION, pgErrorCode, queryRows, type Db, type DbLike } from "@/db/client";
import { SERVICE_WORDS, type Service } from "@/lib/domain/services";
import { daysBetween, isIsoDate, longDateLabel, studioToday, type IsoDate } from "@/lib/domain/time";
import { can } from "@/lib/abilities";
import type { AuthUser } from "./auth";
import { loadSettings } from "./settings";
import { dayBoundsUtc, formatInstant, localDateOf, localToUtc } from "./tz";

/**
 * The admin side of photography: the hours the photographer is ready to work,
 * the time blocked for them, and the packages on sale.
 *
 * A photography session holds the photographer as well as the studio (see
 * `createBooking`), so nobody else can book the photographer for the same
 * time, whatever the studio. What is set here decides which times a customer
 * is offered: inside the working hours, and outside every block and session.
 *
 * Each function checks the viewer itself. The owners can do all of it; staff
 * can set hours and block time when the owners have switched that on
 * (`staffSetsPhotographerTimes`); only the owners change packages and prices.
 */

export interface PhotographerView {
  id: string;
  name: string;
  /** weekday (1-7) -> working hours; a missing weekday means not working. */
  hours: Record<number, { openMinute: number; closeMinute: number }>;
}

export interface PhotographerBlock {
  id: string;
  startAt: string;
  endAt: string;
  note: string;
  /** Set when the block is whole days, from the start of the first to the end of the last. */
  days: { from: IsoDate; to: IsoDate } | null;
}

/** The whole days a block covers, when it starts at the start of a day and ends at the end of one. */
function wholeDaysOf(start: Date, end: Date): { from: IsoDate; to: IsoDate } | null {
  const from = localDateOf(start);
  const to = localDateOf(new Date(end.getTime() - 1));
  if (dayBoundsUtc(from).start.getTime() !== start.getTime() || dayBoundsUtc(to).end.getTime() !== end.getTime()) return null;
  return { from, to };
}

/** "Wednesday, December 3, 2026", or "Wednesday, December 3, 2026 to Friday, December 5, 2026". */
export function daysText(days: { from: IsoDate; to: IsoDate }): string {
  return days.from === days.to ? longDateLabel(days.from) : `${longDateLabel(days.from)} to ${longDateLabel(days.to)}`;
}

/** At most this many days in one go: a year. */
const MOST_DAYS_OFF = 366;

export interface PhotoPackageRow {
  id: string;
  studioId: string;
  studioName: string;
  durationMinutes: number;
  priceCents: number;
  includes: string;
  active: boolean;
}

/**
 * The person customers book for a service's sessions: the first active one of that service. The site starts with a
 * photographer, and a content creator since migration 0063 (question 69).
 */
export async function loadPhotographer(db: DbLike, service: Service = "photography"): Promise<PhotographerView | null> {
  const [person] = await db
    .select()
    .from(photographers)
    .where(and(eq(photographers.active, true), eq(photographers.service, service)))
    .orderBy(asc(photographers.sortOrder), asc(photographers.name))
    .limit(1);
  if (!person) return null;
  const rows = await db.select().from(photographerHours).where(eq(photographerHours.photographerId, person.id));
  return {
    id: person.id,
    name: person.name,
    hours: Object.fromEntries(rows.map((row) => [row.weekday, { openMinute: row.openMinute, closeMinute: row.closeMinute }])),
  };
}

async function maySetTimes(db: DbLike, viewer: AuthUser): Promise<boolean> {
  return can(viewer, "setPhotographerTimes", await loadSettings(db));
}

/** Set the hours the service's person works on one weekday. `null` means they do not work that day. */
export async function savePhotographerHours(
  db: DbLike,
  viewer: AuthUser,
  weekday: number,
  hours: { openMinute: number; closeMinute: number } | null,
  service: Service = "photography",
): Promise<boolean> {
  if (!(await maySetTimes(db, viewer))) return false;
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) return false;
  const person = await loadPhotographer(db, service);
  if (!person) return false;
  if (hours === null) {
    await db
      .delete(photographerHours)
      .where(and(eq(photographerHours.photographerId, person.id), eq(photographerHours.weekday, weekday)));
    return true;
  }
  const { openMinute, closeMinute } = hours;
  if (!Number.isInteger(openMinute) || !Number.isInteger(closeMinute)) return false;
  if (openMinute < 0 || closeMinute > 1440 || openMinute >= closeMinute) return false;
  await db
    .insert(photographerHours)
    .values({ photographerId: person.id, weekday, openMinute, closeMinute })
    .onConflictDoUpdate({ target: [photographerHours.photographerId, photographerHours.weekday], set: { openMinute, closeMinute } });
  return true;
}

export type BlockPhotographerResult = { ok: true; id: string } | { ok: false; message: string };

/**
 * Block part of a day for the photographer: time off, a job elsewhere. No
 * session can be booked into it. A block cannot be laid over a session that
 * is already booked: that session has to be moved or cancelled first.
 */
export async function blockPhotographer(
  db: Db,
  viewer: AuthUser,
  input: { date: string; startMinute: number; endMinute: number; note: string },
  service: Service = "photography",
): Promise<BlockPhotographerResult> {
  const words = SERVICE_WORDS[service];
  if (!(await maySetTimes(db, viewer))) return { ok: false, message: `You cannot change the ${words.person}'s time.` };
  const { date, startMinute, endMinute } = input;
  if (!isIsoDate(date)) return { ok: false, message: "Choose a valid date." };
  if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute) || startMinute < 0 || endMinute > 1440 || startMinute >= endMinute) {
    return { ok: false, message: "The end time must be after the start time." };
  }
  const person = await loadPhotographer(db, service);
  if (!person) return { ok: false, message: `There is no ${words.person} to block time for.` };

  const from = localToUtc(date, startMinute).toISOString();
  const to = localToUtc(date, endMinute).toISOString();
  try {
    const [hold] = await db
      .insert(photographerHolds)
      .values({
        photographerId: person.id,
        occupied: sql`tstzrange(${from}::timestamptz, ${to}::timestamptz, '[)')`,
        note: input.note.slice(0, 200),
      })
      .returning({ id: photographerHolds.id });
    return { ok: true, id: hold.id };
  } catch (error) {
    if (pgErrorCode(error) === PG_EXCLUSION_VIOLATION) {
      return { ok: false, message: `A ${words.session} or another block already takes part of that time.` };
    }
    throw error;
  }
}

/**
 * The photographer's whole days off (the owner's answer of 2026-11-23: "she needs to be able to choose her schedule
 * and black out some days completely", question 70 in ProjectLibrary.md): one day, or several in a row, from the start
 * of the first to the end of the last, as one block. Time already blocked inside those days is joined into it. A session
 * booked on one of them is not moved or cancelled: the block is refused, and the message names each session.
 */
export async function blockPhotographerDays(
  db: Db,
  viewer: AuthUser,
  input: { from: string; to: string; note: string },
  now: Date,
  service: Service = "photography",
): Promise<BlockPhotographerResult> {
  const words = SERVICE_WORDS[service];
  if (!(await maySetTimes(db, viewer))) return { ok: false, message: `You cannot change the ${words.person}'s time.` };
  const from = input.from;
  const to = input.to === "" ? input.from : input.to;
  if (!isIsoDate(from) || !isIsoDate(to)) return { ok: false, message: "Choose valid days." };
  if (to < from) return { ok: false, message: "The last day cannot be before the first." };
  if (from < studioToday(now)) return { ok: false, message: "Choose days from today on." };
  if (daysBetween(from, to) >= MOST_DAYS_OFF) return { ok: false, message: `Block at most ${MOST_DAYS_OFF} days at a time.` };
  const person = await loadPhotographer(db, service);
  if (!person) return { ok: false, message: `There is no ${words.person} to block time for.` };

  const start = dayBoundsUtc(from).start.toISOString();
  const end = dayBoundsUtc(to).end.toISOString();
  const range = sql`tstzrange(${start}::timestamptz, ${end}::timestamptz, '[)')`;
  const sessions = await db
    .select({ ref: bookings.ref, name: bookings.customerName, startAt: bookings.startAt })
    .from(photographerHolds)
    .innerJoin(bookings, eq(bookings.id, photographerHolds.bookingId))
    .where(and(eq(photographerHolds.photographerId, person.id), eq(photographerHolds.active, true), sql`${photographerHolds.occupied} && ${range}`))
    .orderBy(asc(bookings.startAt));
  if (sessions.length > 0) {
    const named = sessions.map((session) => `${session.ref} (${session.name}, ${formatInstant(session.startAt)})`).join(", ");
    return {
      ok: false,
      message: `The ${words.person} has ${sessions.length === 1 ? "a session" : `${sessions.length} sessions`} on those days: ${named}. Move or cancel ${sessions.length === 1 ? "it" : "them"} first, or leave ${sessions.length === 1 ? "that day" : "those days"} out.`,
    };
  }
  try {
    const id = await db.transaction(async (tx) => {
      // Time blocked inside those days becomes part of the whole days; a block reaching past them stays, and refuses.
      await tx
        .delete(photographerHolds)
        .where(and(eq(photographerHolds.photographerId, person.id), isNull(photographerHolds.bookingId), sql`${photographerHolds.occupied} <@ ${range}`));
      const [hold] = await tx
        .insert(photographerHolds)
        .values({ photographerId: person.id, occupied: range, note: input.note.slice(0, 200) })
        .returning({ id: photographerHolds.id });
      return hold.id;
    });
    return { ok: true, id };
  } catch (error) {
    if (pgErrorCode(error) === PG_EXCLUSION_VIOLATION) {
      return { ok: false, message: "Time blocked before reaches into those days from outside them: remove that block first, or choose days around it." };
    }
    throw error;
  }
}

/** Remove a block. Only time blocked by hand can be removed here, never a session's hold. */
export async function unblockPhotographer(db: DbLike, viewer: AuthUser, holdId: string): Promise<boolean> {
  if (!(await maySetTimes(db, viewer))) return false;
  if (!/^[0-9a-f-]{36}$/i.test(holdId)) return false;
  const removed = await db
    .delete(photographerHolds)
    .where(and(eq(photographerHolds.id, holdId), isNull(photographerHolds.bookingId)))
    .returning({ id: photographerHolds.id });
  return removed.length === 1;
}

/** The time blocked for the service's person that has not ended yet, soonest first. */
export async function listPhotographerBlocks(db: DbLike, now: Date, service: Service = "photography"): Promise<PhotographerBlock[]> {
  const rows = await queryRows<{ id: string; start_at: string | Date; end_at: string | Date; note: string }>(
    db,
    sql`
      select hold.id, lower(hold.occupied) as start_at, upper(hold.occupied) as end_at, hold.note
      from ${photographerHolds} hold
      join ${photographers} person on person.id = hold.photographer_id
      where hold.active and hold.booking_id is null and upper(hold.occupied) > ${now.toISOString()}::timestamptz
        and person.service = ${service}
      order by lower(hold.occupied)
    `,
  );
  return rows.map((row) => ({
    id: row.id,
    startAt: new Date(row.start_at).toISOString(),
    endAt: new Date(row.end_at).toISOString(),
    note: row.note,
    days: wholeDaysOf(new Date(row.start_at), new Date(row.end_at)),
  }));
}

/** Every package of a service, on sale or not, by studio and length. */
export async function listPhotoPackages(db: DbLike, service: Service = "photography"): Promise<PhotoPackageRow[]> {
  const rows = await db
    .select({ pack: photoPackages, studioName: studios.name, sort: studios.sortOrder })
    .from(photoPackages)
    .innerJoin(studios, eq(studios.id, photoPackages.studioId))
    .where(eq(photoPackages.service, service))
    .orderBy(asc(studios.sortOrder), asc(photoPackages.durationMinutes));
  return rows.map(({ pack, studioName }) => ({
    id: pack.id,
    studioId: pack.studioId,
    studioName,
    durationMinutes: pack.durationMinutes,
    priceCents: pack.priceCents,
    includes: pack.includes,
    active: pack.active,
  }));
}

/** Change a package's price, what it includes, and whether it is on sale. Sessions already booked keep what they were sold with. */
export async function savePhotoPackage(
  db: DbLike,
  viewer: AuthUser,
  packageId: string,
  input: { priceCents: number; includes: string; active: boolean },
): Promise<boolean> {
  if (viewer.role !== "owner") return false;
  if (!/^[0-9a-f-]{36}$/i.test(packageId)) return false;
  const includes = input.includes.replace(/\s+/g, " ").trim();
  if (!Number.isInteger(input.priceCents) || input.priceCents < 0 || input.priceCents > 10_000_000 || includes.length > 200) return false;
  const updated = await db
    .update(photoPackages)
    .set({ priceCents: input.priceCents, includes, active: input.active })
    .where(eq(photoPackages.id, packageId))
    .returning({ id: photoPackages.id });
  return updated.length === 1;
}

export type AddPackageResult = { ok: true; id: string } | { ok: false; message: string };

/**
 * A session of a service put on sale: a studio, a length, its price with the studio included, and what it includes.
 * Content creation starts with none (question 69): the owners add its sessions here. Owners only.
 */
export async function addPhotoPackage(
  db: DbLike,
  viewer: AuthUser,
  service: Service,
  input: { studioId: string; durationMinutes: number; priceCents: number; includes: string },
): Promise<AddPackageResult> {
  if (viewer.role !== "owner") return { ok: false, message: "Only an owner can put a session on sale." };
  if (!/^[0-9a-f-]{36}$/i.test(input.studioId)) return { ok: false, message: "Choose a studio." };
  const [studio] = await db.select({ id: studios.id, name: studios.name }).from(studios).where(eq(studios.id, input.studioId)).limit(1);
  if (!studio) return { ok: false, message: "Choose a studio." };
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 30 || input.durationMinutes > 720 || input.durationMinutes % 15 !== 0) {
    return { ok: false, message: "A session lasts from 30 minutes to 12 hours, in quarter hours." };
  }
  const includes = input.includes.replace(/\s+/g, " ").trim();
  if (!Number.isInteger(input.priceCents) || input.priceCents <= 0 || input.priceCents > 10_000_000) return { ok: false, message: "Enter the session's price." };
  if (includes.length > 200) return { ok: false, message: "Say what it includes in 200 characters at most." };
  const [taken] = await db
    .select({ id: photoPackages.id })
    .from(photoPackages)
    .where(and(eq(photoPackages.service, service), eq(photoPackages.studioId, studio.id), eq(photoPackages.durationMinutes, input.durationMinutes)))
    .limit(1);
  if (taken) return { ok: false, message: `${studio.name} has a ${SERVICE_WORDS[service].session} of that length already: change it below.` };
  const [row] = await db
    .insert(photoPackages)
    .values({ service, studioId: studio.id, durationMinutes: input.durationMinutes, priceCents: input.priceCents, includes })
    .returning({ id: photoPackages.id });
  return { ok: true, id: row.id };
}
