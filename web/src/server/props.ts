import { and, asc, eq, gt, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { addons, bookingAddons, bookings } from "@/db/schema";

/**
 * Props & Resources (the owner's admin brief of 2026-11-22, item 10): add-ons that are things in a limited number,
 * such as one pair of angel wings. Bookings whose times overlap hold at most `addons.stock` of a prop between them,
 * for the whole appointment. Checked, with the props' rows locked, inside the transaction that makes or moves a
 * booking, so that two bookings at once never take the last one. A cancelled booking holds none. What the builder
 * read into the brief is question 67 in ProjectLibrary.md.
 */

/** The bookings that hold their add-ons: those confirmed, and those being paid for. */
const HOLDING = ["confirmed", "pending_payment"] as const;

/** How many of each prop overlapping bookings hold during [startAt, endAt), leaving out one booking (a booking being moved). */
async function propsReserved(db: DbLike, addonIds: string[], startAt: Date, endAt: Date, exceptBookingId: string | null = null): Promise<Map<string, number>> {
  const ids = [...new Set(addonIds)];
  const held = new Map<string, number>();
  if (ids.length === 0) return held;
  const rows = await db
    .select({ addonId: bookingAddons.addonId, quantity: sql<number>`sum(${bookingAddons.quantity})::int` })
    .from(bookingAddons)
    .innerJoin(bookings, eq(bookings.id, bookingAddons.bookingId))
    .where(
      and(
        inArray(bookingAddons.addonId, ids),
        inArray(bookings.status, [...HOLDING]),
        lt(bookings.startAt, endAt),
        gt(bookings.endAt, startAt),
        exceptBookingId ? ne(bookings.id, exceptBookingId) : undefined,
      ),
    )
    .groupBy(bookingAddons.addonId);
  for (const row of rows) held.set(row.addonId, row.quantity);
  return held;
}

/** The props among `addonIds`, with how many there are. */
async function stockOf(db: DbLike, addonIds: string[], lock: boolean): Promise<{ id: string; name: string; stock: number }[]> {
  const ids = [...new Set(addonIds)].sort();
  if (ids.length === 0) return [];
  const query = db
    .select({ id: addons.id, name: addons.name, stock: addons.stock })
    .from(addons)
    .where(and(inArray(addons.id, ids), isNotNull(addons.stock)))
    .orderBy(asc(addons.id));
  // Locked in the same order everywhere, so that two bookings of the same props never wait on each other in a cycle.
  const rows = lock ? await query.for("update") : await query;
  return rows.map((row) => ({ id: row.id, name: row.name, stock: row.stock! }));
}

/**
 * Whether a booking of these add-ons for [startAt, endAt) leaves no prop held more times than there are. Inside the
 * transaction that writes the booking: the props' rows are locked until it ends. Null when it does, or why not.
 */
export async function propsProblem(
  tx: DbLike,
  wanted: { addonId: string; quantity: number }[],
  startAt: Date,
  endAt: Date,
  exceptBookingId: string | null = null,
): Promise<string | null> {
  const props = await stockOf(tx, wanted.map((item) => item.addonId), true);
  if (props.length === 0) return null;
  const held = await propsReserved(tx, props.map((prop) => prop.id), startAt, endAt, exceptBookingId);
  for (const prop of props) {
    const asked = wanted.filter((item) => item.addonId === prop.id).reduce((sum, item) => sum + item.quantity, 0);
    const free = prop.stock - (held.get(prop.id) ?? 0);
    if (asked > free) {
      // A name may be one thing or several ("Ring light", "Angel wings"): the words do not lean on it.
      return free <= 0
        ? `${prop.name}: already reserved at that time${prop.stock > 1 ? ` (all ${prop.stock})` : ""}. Please choose another time, or leave ${prop.stock === 1 ? "it" : "them"} out.`
        : `${prop.name}: only ${free} free at that time. Please take ${free === 1 ? "one" : `at most ${free}`}, or choose another time.`;
    }
  }
  return null;
}

/** How many of each prop are free for a booking of [startAt, endAt): for the booking page. Add-ons with no limit are left out. */
export async function propsFree(db: DbLike, startAt: Date, endAt: Date): Promise<Record<string, number>> {
  const rows = await db.select({ id: addons.id, stock: addons.stock }).from(addons).where(and(eq(addons.active, true), isNotNull(addons.stock)));
  if (rows.length === 0) return {};
  const held = await propsReserved(db, rows.map((row) => row.id), startAt, endAt);
  return Object.fromEntries(rows.map((row) => [row.id, Math.max(0, row.stock! - (held.get(row.id) ?? 0))]));
}

export interface PropReservation {
  ref: string;
  customerName: string;
  startAt: string;
  endAt: string;
  quantity: number;
}

/** The reservations still to come of each prop, the soonest first: for Props & Resources. */
export async function upcomingReservations(db: DbLike, now: Date): Promise<Map<string, PropReservation[]>> {
  const rows = await db
    .select({
      addonId: bookingAddons.addonId,
      ref: bookings.ref,
      customerName: bookings.customerName,
      startAt: bookings.startAt,
      endAt: bookings.endAt,
      quantity: bookingAddons.quantity,
    })
    .from(bookingAddons)
    .innerJoin(bookings, eq(bookings.id, bookingAddons.bookingId))
    .innerJoin(addons, eq(addons.id, bookingAddons.addonId))
    .where(and(isNotNull(addons.stock), inArray(bookings.status, [...HOLDING]), gt(bookings.endAt, now)))
    .orderBy(asc(bookings.startAt));
  const byProp = new Map<string, PropReservation[]>();
  for (const row of rows) {
    byProp.set(row.addonId, [
      ...(byProp.get(row.addonId) ?? []),
      { ref: row.ref, customerName: row.customerName, startAt: row.startAt.toISOString(), endAt: row.endAt.toISOString(), quantity: row.quantity },
    ]);
  }
  return byProp;
}
