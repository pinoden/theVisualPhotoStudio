import { and, asc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { SERVICE_WORDS, sessionsOf, type Service } from "@/lib/domain/services";
import type { DbLike } from "@/db/client";
import { waitlistEntries } from "@/db/schema";
import { studioCombinationError } from "@/lib/catalog-view";
import { combinedStarts, type StudioDay } from "@/lib/domain/availability";
import { unpriced } from "@/lib/domain/pricing";
import { addDays, durationLabel, isIsoDate, longDateLabel, minutesToLabel, studioToday, type IsoDate } from "@/lib/domain/time";
import { normalizeEmail } from "./auth";
import { loadDayAvailability, type DayAvailability } from "./availability";
import { dayTypeFor, type Catalog } from "./catalog";
import { queueEmail, waitlistOpeningEmail } from "./email";

/**
 * Join Waitlist (the owner's brief of 2026-11-22, item 4): a client asks for a time that is not free, as a range of the
 * day the whole appointment should lie in, and is emailed once, by the scheduled task, when a time that fits frees up
 * (a cancellation, a move, a block removed). Nothing is held for them: the first to book it has it. The same rules as
 * the booking page decide what fits (`loadDayAvailability`, `combinedStarts`). What the builder read into the brief
 * is question 68 in ProjectLibrary.md.
 */

const NAME_MAX = 80;
/** How many places one address may hold at once on the waitlist. */
const MAX_PER_EMAIL = 5;
/** Days after its own day an entry is kept, for the owners to see, before it is deleted. */
const KEEP_DAYS = 30;

export interface WaitlistInput {
  studioIds: string[];
  photography: boolean;
  /** Whose session, for a session (question 69). */
  service?: Service;
  durationMinutes: number;
  date: string;
  fromMinute: number;
  toMinute: number;
  firstName: string;
  lastName: string;
  email: string;
}

export type JoinWaitlistResult =
  | { ok: true; id: string }
  | { ok: false; code: "invalid" | "free_now" | "too_many"; message: string; starts?: number[] };

interface Wanted {
  studioIds: string[];
  photography: boolean;
  service: Service;
  durationMinutes: number;
  fromMinute: number;
  toMinute: number;
}

/** The starts of a day at which `wanted` fits, the whole appointment inside its range. */
function startsIn(day: DayAvailability, wanted: Wanted, increment: number): number[] {
  if (day.problem) return [];
  const held = wanted.studioIds.map((id) => day.days.find((studio) => studio.studioId === id));
  if (held.some((studio) => !studio)) return [];
  const all = held as StudioDay[];
  if (wanted.photography) {
    if (!day.photographer) return [];
    all.push(day.photographer);
  }
  return combinedStarts(all, { durationMinutes: wanted.durationMinutes, incrementMinutes: increment, earliestStartMinute: day.earliestStartMinute }).filter(
    (start) => start >= wanted.fromMinute && start + wanted.durationMinutes <= wanted.toMinute,
  );
}

/** Put a client on the waitlist, unless a time that fits is free now (then they book it), or they hold enough places. */
export async function joinWaitlist(db: DbLike, catalog: Catalog, input: WaitlistInput, now: Date): Promise<JoinWaitlistResult> {
  const invalid = (message: string): JoinWaitlistResult => ({ ok: false, code: "invalid", message });
  const studioIds = [...new Set(input.studioIds)];
  if (studioIds.length === 0 || !studioIds.every((id) => catalog.studios.some((studio) => studio.id === id))) return invalid("Choose a studio.");
  const combination = studioCombinationError(catalog.studios, studioIds);
  if (combination) return invalid(combination);
  if (!isIsoDate(input.date) || input.date < studioToday(now)) return invalid("Choose a day from today on.");
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes <= 0) return invalid("Choose a length.");
  const service = input.service ?? "photography";
  if (input.photography) {
    if (studioIds.length !== 1 || !sessionsOf(catalog.photoPackages, service).some((pack) => pack.studioId === studioIds[0] && pack.durationMinutes === input.durationMinutes)) {
      return invalid("Choose a session this studio offers.");
    }
  } else if (unpriced(studioIds, dayTypeFor(catalog, input.date), input.durationMinutes, catalog.rules, catalog.bundlePrices) !== null) {
    return invalid("That length is not offered on that day.");
  }
  const { fromMinute, toMinute } = input;
  if (!Number.isInteger(fromMinute) || !Number.isInteger(toMinute) || fromMinute < 0 || toMinute > 1440 || fromMinute >= toMinute) {
    return invalid("The end of the time range must be after its start.");
  }
  if (toMinute - fromMinute < input.durationMinutes) return invalid(`The time range must be at least ${durationLabel(input.durationMinutes)} long.`);
  const firstName = input.firstName.replace(/\s+/g, " ").trim();
  const lastName = input.lastName.replace(/\s+/g, " ").trim();
  if (!firstName || firstName.length > NAME_MAX || !lastName || lastName.length > NAME_MAX) return invalid("Please enter your first and last name.");
  const email = normalizeEmail(input.email);
  if (!email) return invalid("Please enter a valid email address.");

  const wanted = { studioIds, photography: input.photography, service, durationMinutes: input.durationMinutes, fromMinute, toMinute };
  const day = await loadDayAvailability(db, catalog, input.date, now, { withPhotographer: input.photography ? service : false });
  if (day.problem) return invalid(day.problem === "too_far" ? "Bookings do not open that far ahead yet." : "Choose a day from today on.");
  const free = startsIn(day, wanted, catalog.settings.slotIncrementMinutes);
  if (free.length > 0) {
    return { ok: false, code: "free_now", message: `A time that fits is free now: ${free.slice(0, 3).map(minutesToLabel).join(", ")}${free.length > 3 ? " and more" : ""}. Book it on this page.`, starts: free };
  }
  const [held] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(waitlistEntries)
    .where(and(eq(waitlistEntries.email, email), isNull(waitlistEntries.removedAt), isNull(waitlistEntries.notifiedAt), gte(waitlistEntries.day, studioToday(now))));
  if (held.n >= MAX_PER_EMAIL) return { ok: false, code: "too_many", message: `You are already waiting for ${MAX_PER_EMAIL} times. We will email you when one opens up.` };
  const [row] = await db
    .insert(waitlistEntries)
    .values({ ...wanted, day: input.date, firstName, lastName, email, createdAt: now })
    .returning({ id: waitlistEntries.id });
  return { ok: true, id: row.id };
}

/** "Studio Paris + Studio Dayglow", or "Photography session, Studio Blanche". */
function whatText(catalog: Catalog, entry: { studioIds: string[]; photography: boolean; service: Service }): string {
  const names = catalog.studios.filter((studio) => entry.studioIds.includes(studio.id)).map((studio) => studio.name);
  return `${entry.photography ? `${SERVICE_WORDS[entry.service].Session}, ` : ""}${names.join(" + ") || "A studio taken off the site"}`;
}

/** The booking page with the place's studios, day and length chosen. */
function bookingLink(baseUrl: string, catalog: Catalog, entry: { studioIds: string[]; photography: boolean; service: Service; day: string; durationMinutes: number }): string {
  const slugs = catalog.studios.filter((studio) => entry.studioIds.includes(studio.id)).map((studio) => studio.slug);
  return `${baseUrl}${entry.photography ? SERVICE_WORDS[entry.service].bookPath : "/book"}?studio=${slugs.join(",")}&date=${entry.day}&duration=${entry.durationMinutes}`;
}

/**
 * From the scheduled task: email each client waiting for a time that fits now, once, and delete the places whose day
 * passed more than `KEEP_DAYS` ago. Answers how many were emailed. Safe to run twice: an emailed place is not emailed again.
 */
export async function noticeWaitlist(db: DbLike, catalog: Catalog, deps: { now: Date; baseUrl: string }): Promise<number> {
  const today = studioToday(deps.now);
  await db.delete(waitlistEntries).where(lt(waitlistEntries.day, addDays(today, -KEEP_DAYS)));
  const waiting = await db
    .select()
    .from(waitlistEntries)
    .where(and(isNull(waitlistEntries.removedAt), isNull(waitlistEntries.notifiedAt), gte(waitlistEntries.day, today)))
    .orderBy(asc(waitlistEntries.day), asc(waitlistEntries.createdAt));
  const days = new Map<string, DayAvailability>();
  let emailed = 0;
  for (const entry of waiting) {
    const key = `${entry.day}|${entry.photography ? entry.service : "rental"}`;
    const day = days.get(key) ?? (await loadDayAvailability(db, catalog, entry.day, deps.now, { withPhotographer: entry.photography ? entry.service : false }));
    days.set(key, day);
    if (startsIn(day, entry, catalog.settings.slotIncrementMinutes).length === 0) continue;
    // Marked first: a task that runs twice at once emails the place once.
    const [taken] = await db
      .update(waitlistEntries)
      .set({ notifiedAt: deps.now })
      .where(and(eq(waitlistEntries.id, entry.id), isNull(waitlistEntries.notifiedAt)))
      .returning({ id: waitlistEntries.id });
    if (!taken) continue;
    await queueEmail(
      db,
      waitlistOpeningEmail({
        to: entry.email,
        name: `${entry.firstName} ${entry.lastName}`,
        studios: whatText(catalog, entry),
        duration: durationLabel(entry.durationMinutes),
        day: longDateLabel(entry.day),
        timeRange: `${minutesToLabel(entry.fromMinute)} and ${minutesToLabel(entry.toMinute)}`,
        link: bookingLink(deps.baseUrl, catalog, entry),
      }),
    );
    emailed++;
  }
  return emailed;
}

export interface WaitlistView {
  id: string;
  what: string;
  duration: string;
  day: IsoDate;
  timeRange: string;
  name: string;
  email: string;
  createdAt: string;
  notifiedAt: string | null;
  removedAt: string | null;
}

/** The waitlist for the admin, from `since` on, the soonest day first. */
export async function listWaitlist(db: DbLike, catalog: Catalog, since: IsoDate): Promise<WaitlistView[]> {
  const rows = await db.select().from(waitlistEntries).where(gte(waitlistEntries.day, since)).orderBy(asc(waitlistEntries.day), asc(waitlistEntries.fromMinute), asc(waitlistEntries.createdAt));
  return rows.map((row) => ({
    id: row.id,
    what: whatText(catalog, row),
    duration: durationLabel(row.durationMinutes),
    day: row.day,
    timeRange: `${minutesToLabel(row.fromMinute)} – ${minutesToLabel(row.toMinute)}`,
    name: `${row.firstName} ${row.lastName}`,
    email: row.email,
    createdAt: row.createdAt.toISOString(),
    notifiedAt: row.notifiedAt ? row.notifiedAt.toISOString() : null,
    removedAt: row.removedAt ? row.removedAt.toISOString() : null,
  }));
}

/** Take a place off the waitlist: it is not emailed. */
export async function removeFromWaitlist(db: DbLike, id: string, by: string, now: Date): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const removed = await db
    .update(waitlistEntries)
    .set({ removedAt: now, removedBy: by })
    .where(and(eq(waitlistEntries.id, id), isNull(waitlistEntries.removedAt)))
    .returning({ id: waitlistEntries.id });
  return removed.length > 0;
}
