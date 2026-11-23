import { and, asc, eq, gt, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import type { Db, DbLike } from "@/db/client";
import { addons, bookingAddons, bookings, media } from "@/db/schema";
import { isIsoDate, longDateLabel, type IsoDate } from "@/lib/domain/time";
import type { AuthUser } from "./auth";
import { localDateOf } from "./tz";

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

interface Prop {
  id: string;
  name: string;
  stock: number;
  awayFrom: string | null;
  awayTo: string | null;
}

/** Whether a prop is away (marked unavailable for a while) on any day of [startAt, endAt). */
function awayDuring(prop: Pick<Prop, "awayFrom" | "awayTo">, startAt: Date, endAt: Date): boolean {
  if (prop.awayFrom === null || prop.awayTo === null) return false;
  const first = localDateOf(startAt);
  const last = localDateOf(new Date(Math.max(startAt.getTime(), endAt.getTime() - 1)));
  return prop.awayFrom <= last && prop.awayTo >= first;
}

/** The props among `addonIds`, with how many there are. */
async function stockOf(db: DbLike, addonIds: string[], lock: boolean): Promise<Prop[]> {
  const ids = [...new Set(addonIds)].sort();
  if (ids.length === 0) return [];
  const query = db
    .select({ id: addons.id, name: addons.name, stock: addons.stock, awayFrom: addons.awayFrom, awayTo: addons.awayTo })
    .from(addons)
    .where(and(inArray(addons.id, ids), isNotNull(addons.stock)))
    .orderBy(asc(addons.id));
  // Locked in the same order everywhere, so that two bookings of the same props never wait on each other in a cycle.
  const rows = lock ? await query.for("update") : await query;
  return rows.map((row) => ({ ...row, stock: row.stock! }));
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
    if (asked > 0 && awayDuring(prop, startAt, endAt)) {
      return `${prop.name}: not available on that day. Please choose another day, or leave ${prop.stock === 1 ? "it" : "them"} out.`;
    }
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

/**
 * How many of each prop are free for a booking of [startAt, endAt), and which are away on its day: for the booking page.
 * Add-ons with no limit are left out. A prop away counts none free.
 */
export async function propsFree(db: DbLike, startAt: Date, endAt: Date): Promise<{ free: Record<string, number>; away: string[] }> {
  const rows = await db
    .select({ id: addons.id, stock: addons.stock, awayFrom: addons.awayFrom, awayTo: addons.awayTo })
    .from(addons)
    .where(and(eq(addons.active, true), isNotNull(addons.stock)));
  if (rows.length === 0) return { free: {}, away: [] };
  const held = await propsReserved(db, rows.map((row) => row.id), startAt, endAt);
  const away = rows.filter((row) => awayDuring(row, startAt, endAt)).map((row) => row.id);
  return { free: Object.fromEntries(rows.map((row) => [row.id, away.includes(row.id) ? 0 : Math.max(0, row.stock! - (held.get(row.id) ?? 0))])), away };
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

export type PropChangeResult = { ok: true; message: string } | { ok: false; message: string };

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/**
 * Give a prop its picture from the media library, or none (`mediaId` ""). The owners'. As a studio's photos, a picture
 * has to say what it shows first: the booking page reads that out in its place.
 */
export async function setPropPicture(db: Db, viewer: AuthUser, addonId: string, mediaId: string): Promise<PropChangeResult> {
  if (viewer.role !== "owner") return { ok: false, message: "Only an owner can change a prop." };
  if (!isUuid(addonId)) return { ok: false, message: "That add-on was not found." };
  if (mediaId !== "" && !isUuid(mediaId)) return { ok: false, message: "Choose a picture." };
  return db.transaction(async (tx): Promise<PropChangeResult> => {
    const [addon] = await tx.select({ id: addons.id, name: addons.name }).from(addons).where(eq(addons.id, addonId)).for("update").limit(1);
    if (!addon) return { ok: false, message: "That add-on was not found." };
    if (mediaId !== "") {
      const [picture] = await tx.select({ alt: media.alt, filename: media.filename }).from(media).where(eq(media.id, mediaId)).limit(1);
      if (!picture) return { ok: false, message: "That picture is no longer in the library." };
      if (picture.alt.trim() === "") return { ok: false, message: `Say what the picture ${picture.filename} shows first, in the media library. Then choose it here.` };
    }
    await tx.update(addons).set({ mediaId: mediaId === "" ? null : mediaId }).where(eq(addons.id, addonId));
    return { ok: true, message: mediaId === "" ? `The picture of ${addon.name} is taken away.` : `Picture chosen for ${addon.name}. Clients see it on the booking page now.` };
  });
}

/** "Tuesday, December 1, 2026 to Saturday, December 5, 2026", or the one day. */
export function awayText(from: string, to: string): string {
  return from === to ? longDateLabel(from as IsoDate) : `${longDateLabel(from as IsoDate)} to ${longDateLabel(to as IsoDate)}`;
}

/**
 * Mark a prop unavailable from one day to another, both included, or available again (`away` null): the admin brief
 * of 2026-11-22, item 10. While it is away, no booking or move can take it on those days. Bookings made before keep it:
 * the answer names them, for the owners to see to (question 67 in ProjectLibrary.md).
 */
export async function setPropAway(db: Db, viewer: AuthUser, addonId: string, away: { from: string; to: string } | null, now: Date): Promise<PropChangeResult> {
  if (viewer.role !== "owner") return { ok: false, message: "Only an owner can change a prop." };
  if (!isUuid(addonId)) return { ok: false, message: "That add-on was not found." };
  if (away) {
    if (!isIsoDate(away.from) || !isIsoDate(away.to)) return { ok: false, message: "Choose the first and the last day it is away." };
    if (away.from > away.to) return { ok: false, message: "The last day cannot come before the first." };
    if (away.to < localDateOf(now)) return { ok: false, message: "Those days have passed. Choose days from today on." };
  }
  const [addon] = await db
    .update(addons)
    .set({ awayFrom: away?.from ?? null, awayTo: away?.to ?? null })
    .where(and(eq(addons.id, addonId), isNotNull(addons.stock)))
    .returning({ id: addons.id, name: addons.name });
  if (!addon) return { ok: false, message: "That prop was not found: an add-on needs a number (\"How many there are\") to be a prop." };
  if (!away) return { ok: true, message: `${addon.name} can be booked again on every day.` };
  const days = awayText(away.from, away.to);
  const holding = ((await upcomingReservations(db, now)).get(addon.id) ?? []).filter((reservation) =>
    awayDuring({ awayFrom: away.from, awayTo: away.to }, new Date(reservation.startAt), new Date(reservation.endAt)),
  );
  if (holding.length === 0) return { ok: true, message: `${addon.name} is away ${away.from === away.to ? "on" : "from"} ${days}: it cannot be booked then.` };
  return {
    ok: true,
    message: `${addon.name} is away ${away.from === away.to ? "on" : "from"} ${days}: it cannot be booked then. ${holding.length === 1 ? "A booking made before has it reserved then" : `${holding.length} bookings made before have it reserved then`}: ${holding.map((reservation) => `${reservation.ref} (${reservation.customerName})`).join(", ")}. Tell ${holding.length === 1 ? "that client" : "those clients"}, or change ${holding.length === 1 ? "the booking" : "the bookings"}.`,
  };
}
