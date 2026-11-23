import { randomUUID } from "node:crypto";
import { eq, inArray, or, sql } from "drizzle-orm";
import { PG_EXCLUSION_VIOLATION, pgErrorCode, queryRows, type Db, type DbLike } from "@/db/client";
import { blocks, studioHolds, studios } from "@/db/schema";
import { addDays, daysBetween, isIsoDate, isoWeekday, minutesToLabel, studioToday, type IsoDate } from "@/lib/domain/time";
import { formatRange, localDateOf, localMinuteOn, localMinuteOnFloor, localToUtc } from "./tz";

/**
 * Availability & Blocked Time (the owner's admin brief of 2026-11-22, item 12): taking studios off what clients can
 * book, for a time, a whole day, several days, a range or every week, one studio, several or all of them, with a
 * reason. A block is still one day's hold on each of its studios (`studio_holds`, which the database keeps from
 * overlapping anything else); the blocks made together share a series (`blocks.series_id`) and are listed, changed and
 * removed as one. A block over an appointment is refused, and the appointments are named: nothing is cancelled for
 * it, the administrator moves or cancels them first. What the builder read into the brief is question 65.
 */

export const BLOCK_REASONS = {
  maintenance: "Maintenance",
  holiday: "Holiday Closure",
  private_event: "Private Event",
  other: "Other",
} as const;
export type BlockReason = keyof typeof BLOCK_REASONS;

const isReason = (value: string): value is BlockReason => Object.hasOwn(BLOCK_REASONS, value);

/** The most days one plan may block: a year and a little. */
const MAX_BLOCK_DAYS = 370;
const NOTE_MAX = 200;

export interface BlockPlan {
  studioIds: string[];
  /** The first and the last day, both included. */
  from: string;
  to: string;
  wholeDay: boolean;
  /** Minutes from the studio's midnight; left out of a whole day. */
  startMinute: number;
  endMinute: number;
  /** Only these days of the week (1 Monday to 7 Sunday): a weekly repeat. Empty for every day of the range. */
  weekdays: number[];
  reason: string;
  note: string;
}

export interface BlockConflict {
  /** An appointment's reference, or null for another block. */
  ref: string | null;
  customerName: string;
  studio: string;
  day: string;
  time: string;
}

export type BlockPlanResult = { ok: true; key: string; days: number } | { ok: false; message: string; conflicts: BlockConflict[] };

const refuse = (message: string): BlockPlanResult => ({ ok: false, message, conflicts: [] });

/** The days a plan blocks, or why it cannot. */
export function daysOfPlan(plan: Pick<BlockPlan, "from" | "to" | "weekdays">, today: IsoDate): IsoDate[] | string {
  if (!isIsoDate(plan.from)) return "Choose the first day.";
  const to = plan.to === "" ? plan.from : plan.to;
  if (!isIsoDate(to)) return "Choose a valid last day.";
  if (to < plan.from) return "The last day must be on or after the first.";
  if (plan.from < today) return "Choose a day from today on.";
  const span = daysBetween(plan.from, to) + 1;
  if (span > MAX_BLOCK_DAYS) return `Block at most ${MAX_BLOCK_DAYS} days at a time.`;
  const weekdays = new Set(plan.weekdays);
  if ([...weekdays].some((day) => !Number.isInteger(day) || day < 1 || day > 7)) return "Choose days of the week from Monday to Sunday.";
  const days = Array.from({ length: span }, (_, index) => addDays(plan.from, index)).filter((day) => weekdays.size === 0 || weekdays.has(isoWeekday(day)));
  return days.length > 0 ? days : "None of those days is one of the days of the week chosen.";
}

/** What a plan says, checked: its days and times, or why it cannot be made. */
function checked(plan: BlockPlan, now: Date): { days: IsoDate[]; start: number; end: number; reason: BlockReason | ""; note: string } | string {
  if (plan.studioIds.length === 0) return "Choose at least one studio, or Select All Studios.";
  const days = daysOfPlan(plan, studioToday(now));
  if (typeof days === "string") return days;
  const [start, end] = plan.wholeDay ? [0, 1440] : [plan.startMinute, plan.endMinute];
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 1440 || start >= end) return "The end time must be after the start time.";
  const reason = plan.reason.trim();
  if (reason !== "" && !isReason(reason)) return "Choose a reason from the list.";
  return { days, start, end, reason: reason as BlockReason | "", note: plan.note.trim().slice(0, NOTE_MAX) };
}

/**
 * What already holds part of these spans in these studios: appointments, by their own time, and blocks of another
 * series. One read of the whole range; each day's span is compared here.
 */
async function conflictsOf(db: DbLike, studioIds: string[], spans: { start: Date; end: Date }[], exceptKey: string | null): Promise<BlockConflict[]> {
  const first = spans[0].start;
  const last = spans[spans.length - 1].end;
  const rows = await queryRows<{
    start_at: string | Date;
    end_at: string | Date;
    studio: string;
    ref: string | null;
    customer_name: string | null;
    booking_start: string | Date | null;
    booking_end: string | Date | null;
    series: string | null;
  }>(
    db,
    sql`
      select lower(h.occupied) as start_at, upper(h.occupied) as end_at, s.name as studio, b.ref, b.customer_name,
             b.start_at as booking_start, b.end_at as booking_end, coalesce(k.series_id, k.id) as series
      from studio_holds h
      join studios s on s.id = h.studio_id
      left join bookings b on b.id = h.booking_id
      left join blocks k on k.id = h.block_id
      where h.active
        and h.studio_id in (${sql.join(studioIds.map((id) => sql`${id}::uuid`), sql`, `)})
        and h.occupied && tstzrange(${first.toISOString()}::timestamptz, ${last.toISOString()}::timestamptz, '[)')
      order by lower(h.occupied), s.sort_order
    `,
  );
  return rows
    .filter((row) => (exceptKey === null || row.series === null || row.series !== exceptKey))
    .filter((row) => {
      const [start, end] = [new Date(row.start_at).getTime(), new Date(row.end_at).getTime()];
      return spans.some((span) => start < span.end.getTime() && end > span.start.getTime());
    })
    .map((row) => {
      const when = formatRange(new Date(row.booking_start ?? row.start_at), new Date(row.booking_end ?? row.end_at));
      return { ref: row.ref, customerName: row.customer_name ?? "", studio: row.studio, day: when.day, time: when.time };
    });
}

/** "Nothing was blocked. 2 appointments hold part of that time: …": the appointments first, then time blocked already. */
function conflictMessage(conflicts: BlockConflict[]): string {
  const appointments = conflicts.filter((conflict) => conflict.ref !== null);
  const blocked = conflicts.filter((conflict) => conflict.ref === null);
  const named = [...appointments, ...blocked]
    .slice(0, 5)
    .map((conflict) => (conflict.ref ? `${conflict.ref} (${conflict.customerName}, ${conflict.studio}, ${conflict.day}, ${conflict.time})` : `a block (${conflict.studio}, ${conflict.day}, ${conflict.time})`))
    .join("; ");
  const more = conflicts.length > 5 ? `, and ${conflicts.length - 5} more` : "";
  const what =
    appointments.length > 0
      ? `${appointments.length === 1 ? "An appointment holds" : `${appointments.length} appointments hold`} part of that time${blocked.length > 0 ? ", and part of it is blocked already" : ""}`
      : "Part of that time is blocked already";
  const fix = appointments.length > 0 ? "Move or cancel the appointments first, or leave that time out." : "Change that block instead, or leave that time out.";
  return `Nothing was blocked. ${what}: ${named}${more}. ${fix}`;
}

/** Write a series' blocks, one for each day, each holding every studio. Inside the caller's transaction. */
async function insertSeries(tx: DbLike, key: string, plan: { days: IsoDate[]; start: number; end: number; reason: string; note: string }, studioIds: string[]): Promise<void> {
  for (const day of plan.days) {
    const [block] = await tx.insert(blocks).values({ note: plan.note, reason: plan.reason, seriesId: key }).returning({ id: blocks.id });
    const from = localToUtc(day, plan.start).toISOString();
    const to = localToUtc(day, plan.end).toISOString();
    for (const studioId of studioIds) {
      await tx.insert(studioHolds).values({ studioId, blockId: block.id, occupied: sql`tstzrange(${from}::timestamptz, ${to}::timestamptz, '[)')` });
    }
  }
}

/** The studios asked for, if every one is known. */
async function knownStudios(db: DbLike, ids: string[]): Promise<string[] | null> {
  const unique = [...new Set(ids)].sort();
  if (unique.length === 0) return [];
  const found = await db.select({ id: studios.id }).from(studios).where(inArray(studios.id, unique));
  return found.length === unique.length ? unique : null;
}

/** Block a plan's days in its studios, all or none. Refused, naming them, when an appointment or another block holds part of it. */
export async function createBlocks(db: Db, plan: BlockPlan, now: Date): Promise<BlockPlanResult> {
  return saveBlocks(db, plan, now, null);
}

/** Replace a series with a plan, all or none: the series does not stand in its own way. */
export async function updateBlocks(db: Db, key: string, plan: BlockPlan, now: Date): Promise<BlockPlanResult> {
  return saveBlocks(db, plan, now, key);
}

async function saveBlocks(db: Db, plan: BlockPlan, now: Date, replacing: string | null): Promise<BlockPlanResult> {
  const studioIds = await knownStudios(db, plan.studioIds);
  if (studioIds === null) return refuse("Unknown studio.");
  const ready = checked({ ...plan, studioIds }, now);
  if (typeof ready === "string") return refuse(ready);
  const spans = ready.days.map((day) => ({ start: localToUtc(day, ready.start), end: localToUtc(day, ready.end) }));
  const conflicts = await conflictsOf(db, studioIds, spans, replacing);
  if (conflicts.length > 0) return { ok: false, message: conflictMessage(conflicts), conflicts };
  const key = replacing ?? randomUUID();
  try {
    await db.transaction(async (tx) => {
      if (replacing) await tx.delete(blocks).where(or(eq(blocks.seriesId, replacing), eq(blocks.id, replacing)));
      await insertSeries(tx, key, ready, studioIds);
    });
  } catch (error) {
    // Something was booked between the check and the write: the database keeps holds from overlapping.
    if (pgErrorCode(error) === PG_EXCLUSION_VIOLATION) return refuse("Nothing was blocked: a booking was made in that time a moment ago. Look at the calendar and try again.");
    throw error;
  }
  return { ok: true, key, days: ready.days.length };
}

/** Remove a series, or a block of one day made alone (the key is then its own id). */
export async function removeBlocks(db: DbLike, key: string): Promise<number> {
  if (!/^[0-9a-f-]{36}$/i.test(key)) return 0;
  const removed = await db.delete(blocks).where(or(eq(blocks.seriesId, key), eq(blocks.id, key))).returning({ id: blocks.id });
  return removed.length; // their holds go with them
}

export interface BlockSeries {
  /** The series' id, or a lone block's own. */
  key: string;
  reason: BlockReason | "";
  note: string;
  studioIds: string[];
  studios: string[];
  /** Each day still to come, with its time in studio time. */
  days: { date: IsoDate; startMinute: number; endMinute: number }[];
}

/** The blocks still to end after `from`, as series, the soonest first. */
export async function listBlockSeries(db: DbLike, from: Date): Promise<BlockSeries[]> {
  const rows = await queryRows<{ key: string; reason: string; note: string; studio_id: string; name: string; sort_order: number; start_at: string | Date; end_at: string | Date }>(
    db,
    sql`
      select coalesce(k.series_id, k.id) as key, k.reason, k.note, s.id as studio_id, s.name, s.sort_order, lower(h.occupied) as start_at, upper(h.occupied) as end_at
      from blocks k
      join studio_holds h on h.block_id = k.id and h.active
      join studios s on s.id = h.studio_id
      where upper(h.occupied) > ${from.toISOString()}::timestamptz
      order by lower(h.occupied), s.sort_order
    `,
  );
  const byKey = new Map<string, BlockSeries & { order: Map<string, number> }>();
  for (const row of rows) {
    const series =
      byKey.get(row.key) ??
      byKey
        .set(row.key, { key: row.key, reason: isReason(row.reason) ? row.reason : "", note: row.note, studioIds: [], studios: [], days: [], order: new Map() })
        .get(row.key)!;
    if (!series.studioIds.includes(row.studio_id)) {
      series.studioIds.push(row.studio_id);
      series.order.set(row.name, row.sort_order);
    }
    const start = new Date(row.start_at);
    const date = localDateOf(start);
    if (!series.days.some((day) => day.date === date)) {
      series.days.push({ date, startMinute: localMinuteOnFloor(start, date), endMinute: Math.min(1440, localMinuteOn(new Date(row.end_at), date)) });
    }
  }
  return [...byKey.values()].map(({ order, ...series }) => ({
    ...series,
    studios: [...order.keys()].sort((a, b) => order.get(a)! - order.get(b)!),
  }));
}

/** A series as the form's plan, to change it: its first and last day, its days of the week if it skips some, its time. */
export function planOf(series: BlockSeries): BlockPlan {
  const first = series.days[0];
  const last = series.days[series.days.length - 1];
  const every = daysBetween(first.date, last.date) + 1 === series.days.length;
  const wholeDay = first.startMinute === 0 && first.endMinute === 1440;
  return {
    studioIds: series.studioIds,
    from: first.date,
    to: last.date,
    wholeDay,
    startMinute: first.startMinute,
    endMinute: first.endMinute,
    weekdays: every ? [] : [...new Set(series.days.map((day) => isoWeekday(day.date)))].sort(),
    reason: series.reason,
    note: series.note,
  };
}

/** "Entire day", or "9:00 AM – 12:00 PM". */
export function blockTimeText(day: { startMinute: number; endMinute: number }): string {
  return day.startMinute === 0 && day.endMinute === 1440 ? "Entire day" : `${minutesToLabel(day.startMinute)} – ${minutesToLabel(day.endMinute)}`;
}
