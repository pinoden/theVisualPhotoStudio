import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { blocks, bookings, staffShifts, studioHolds } from "@/db/schema";
import { queryRows, type DbLike } from "@/db/client";
import { can } from "@/lib/abilities";
import { labelOf, type LabelKey } from "@/lib/domain/labels";
import { addDays, type IsoDate } from "@/lib/domain/time";
import type { AuthUser } from "./auth";
import type { Catalog } from "./catalog";
import { BLOCK_REASONS, type BlockReason } from "./blocked-time";
import { loadSettings } from "./settings";
import { dayBoundsUtc, localDateOf, localMinuteOn, localMinuteOnFloor } from "./tz";

/**
 * What the admin calendar shows for a span of days: the appointments, and the
 * time the owners blocked. One appointment appears once for each studio it
 * holds, because each studio has a calendar of its own.
 *
 * Staff get the days they may see: the ones assigned to them, or every day
 * when the owners have switched that on. Other days come back empty, and
 * `days` says which ones were looked at.
 */
export interface CalendarAppointment {
  ref: string;
  date: IsoDate;
  /** Minutes from studio-local midnight. */
  startMinute: number;
  endMinute: number;
  studioIds: string[];
  customerName: string;
  label: LabelKey;
  /** A photography session: the photographer is held for it too. */
  photography: boolean;
}

export interface CalendarBlock {
  date: IsoDate;
  startMinute: number;
  endMinute: number;
  studioId: string;
  note: string;
}

export interface CalendarData {
  appointments: CalendarAppointment[];
  blocks: CalendarBlock[];
  /** The days of the span this viewer may see. */
  days: IsoDate[];
}

export async function loadCalendar(
  db: DbLike,
  viewer: AuthUser,
  catalog: Pick<Catalog, "studios">,
  span: { from: IsoDate; to: IsoDate },
): Promise<CalendarData> {
  const all: IsoDate[] = [];
  for (let day = span.from; day < span.to; day = addDays(day, 1)) all.push(day);

  let days = all;
  if (viewer.role !== "owner") {
    if (viewer.role !== "staff" && viewer.role !== "manager") return { appointments: [], blocks: [], days: [] };
    if (!can(viewer, "seeAllDays", await loadSettings(db))) {
      const shifts = await db
        .select({ day: staffShifts.day })
        .from(staffShifts)
        .where(and(eq(staffShifts.userId, viewer.id), gte(staffShifts.day, span.from), lt(staffShifts.day, span.to)));
      const mine = new Set(shifts.map((shift) => shift.day));
      days = all.filter((day) => mine.has(day));
    }
  }
  if (days.length === 0) return { appointments: [], blocks: [], days };
  const visible = new Set(days);

  const from = dayBoundsUtc(span.from).start;
  const to = dayBoundsUtc(addDays(span.to, -1)).end;
  const rows = await db
    .select()
    .from(bookings)
    .where(
      and(gte(bookings.startAt, from), lt(bookings.startAt, to), inArray(bookings.status, ["confirmed", "completed", "no_show"])),
    )
    .orderBy(asc(bookings.startAt));
  const shown = rows.filter((row) => visible.has(localDateOf(row.startAt)));

  const known = new Set(catalog.studios.map((studio) => studio.id));
  const holds =
    shown.length === 0
      ? []
      : await db
          .select({ bookingId: studioHolds.bookingId, studioId: studioHolds.studioId })
          .from(studioHolds)
          .where(
            inArray(
              studioHolds.bookingId,
              shown.map((row) => row.id),
            ),
          );

  const appointments = shown.map((row) => {
    const date = localDateOf(row.startAt);
    return {
      ref: row.ref,
      date,
      startMinute: localMinuteOnFloor(row.startAt, date),
      endMinute: localMinuteOn(row.endAt, date),
      studioIds: holds.filter((hold) => hold.bookingId === row.id && known.has(hold.studioId)).map((hold) => hold.studioId),
      customerName: row.customerName,
      label: labelOf(row),
      photography: row.photographerId !== null,
    };
  });

  // Time the owners blocked. A block is made for one day, so its span is cut to each day it touches.
  const blockRows = await queryRows<{ studio_id: string; start_at: string | Date; end_at: string | Date; note: string; reason: string }>(
    db,
    sql`
      select h.studio_id, lower(h.occupied) as start_at, upper(h.occupied) as end_at, b.note, b.reason
      from ${studioHolds} h
      join ${blocks} b on b.id = h.block_id
      where h.active
        and h.occupied && tstzrange(${from.toISOString()}::timestamptz, ${to.toISOString()}::timestamptz, '[)')
    `,
  );
  const blocked: CalendarBlock[] = [];
  for (const row of blockRows) {
    if (!known.has(row.studio_id)) continue;
    for (const date of days) {
      const startMinute = localMinuteOnFloor(new Date(row.start_at), date);
      const endMinute = localMinuteOn(new Date(row.end_at), date);
      // What the calendar says on it: the note, else the reason ("Holiday Closure"), else "Blocked".
      const said = row.note || (Object.hasOwn(BLOCK_REASONS, row.reason) ? BLOCK_REASONS[row.reason as BlockReason] : "");
      if (endMinute > startMinute) blocked.push({ date, startMinute, endMinute, studioId: row.studio_id, note: said });
    }
  }

  return { appointments, blocks: blocked, days };
}
