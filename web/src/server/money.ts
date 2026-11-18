import { and, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { bookingCharges, payments, refunds } from "@/db/schema";
import { together, type DbLike } from "@/db/client";
import { MANUAL_PROVIDER } from "@/lib/payment-methods";
import { RESERVE_HOURS } from "./payments";

/**
 * What is held for a booking, by where the money is.
 *
 * Two kinds of payment exist. A card charged through the site sits with the
 * processor, and the site can send it back. Money taken at the studio and
 * recorded by hand ("mark as paid") never passed through the site: a refund
 * of it is the studio's to make, and to record.
 */

/** A booking that stands, and so can owe money: one cancelled, released for a reschedule code or never made owes nothing. */
export const STANDS: readonly string[] = ["confirmed", "completed", "no_show"];

/**
 * Card money still held for a booking: payments charged through the site,
 * less every refund recorded against them. A refund that failed counts too:
 * it is owed, and is tried again until it is made (or the owner records it
 * as made in Square), so it cannot be refunded a second time meanwhile.
 */
export async function netCardPaidCents(db: DbLike, bookingId: string): Promise<number> {
  const viaSite = and(eq(payments.bookingId, bookingId), ne(payments.provider, MANUAL_PROVIDER));
  const [paid] = await db
    .select({ total: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int` })
    .from(payments)
    .where(and(viaSite, eq(payments.status, "succeeded")));
  // Refunds of the payments counted above: an amount only reserved, or a payment that failed, holds nothing to refund.
  const [back] = await db
    .select({ total: sql<number>`coalesce(sum(${refunds.amountCents}), 0)::int` })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .where(and(viaSite, eq(payments.status, "succeeded"), inArray(refunds.status, ["pending", "succeeded", "failed"])));
  return paid.total - back.total;
}

/** Money taken at the studio for a booking and recorded by hand, less what was given back by hand. */
export async function paidAtStudioCents(db: DbLike, bookingId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${payments.amountCents} - ${payments.refundedCents}), 0)::int` })
    .from(payments)
    .where(and(eq(payments.bookingId, bookingId), eq(payments.provider, MANUAL_PROVIDER), eq(payments.status, "succeeded")));
  return row.total;
}

/**
 * What each booking still owes, of those given: for one that stands, its
 * price and the extra charges added to it since (`chargesCentsByBooking`), less what it received and what a card holds reserved for it, which is
 * taken shortly; nothing for one that ended. A booking made online is paid
 * when it is made, so it owes only when its card's amount was reserved and
 * never taken: once the reservation has lapsed (`RESERVE_HOURS`), the card
 * holds nothing, and the studio collects the price. One made in the admin
 * owes until it is paid.
 */
export async function owedCentsByBooking(
  db: DbLike,
  rows: { id: string; totalCents: number; status: string }[],
  now: Date,
): Promise<Map<string, number>> {
  const standing = rows.filter((row) => STANDS.includes(row.status));
  if (standing.length === 0) return new Map(rows.map((row) => [row.id, 0]));
  const ids = standing.map((row) => row.id);
  const [received, held, charged] = await together(db, [
    () => receivedCentsByBooking(db, ids),
    () => heldCentsByBooking(db, ids, now),
    () => chargesCentsByBooking(db, ids),
  ]);
  return new Map(
    rows.map((row) => [
      row.id,
      STANDS.includes(row.status)
        ? Math.max(0, row.totalCents + (charged.get(row.id) ?? 0) - (received.get(row.id) ?? 0) - (held.get(row.id) ?? 0))
        : 0,
    ]),
  );
}

/**
 * For several bookings at once: what a card holds reserved for each, not taken yet. That is a moment after the
 * booking is made, or longer when taking it did not go through, which the scheduled task tries again; until the
 * reservation lapses (`RESERVE_HOURS`), when the card holds nothing. A booking whose card holds nothing is not in the map.
 */
export async function heldCentsByBooking(db: DbLike, bookingIds: string[], now: Date): Promise<Map<string, number>> {
  if (bookingIds.length === 0) return new Map();
  const lapsedBefore = new Date(now.getTime() - RESERVE_HOURS * 3_600_000);
  const rows = await db
    .select({ bookingId: payments.bookingId, total: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int` })
    .from(payments)
    .where(and(inArray(payments.bookingId, bookingIds), eq(payments.status, "authorized"), gt(payments.createdAt, lapsedBefore)))
    .groupBy(payments.bookingId);
  return new Map(rows.map((row) => [row.bookingId, row.total]));
}

/** What one booking still owes (`owedCentsByBooking`). */
export async function owedCents(db: DbLike, booking: { id: string; totalCents: number; status: string }, now: Date): Promise<number> {
  return (await owedCentsByBooking(db, [booking], now)).get(booking.id) ?? 0;
}

/**
 * For several bookings at once: what each has received (every payment that
 * succeeded, before refunds). A booking that received nothing is not in the map.
 */
export async function receivedCentsByBooking(db: DbLike, bookingIds: string[], where: "anywhere" | "at_studio" = "anywhere"): Promise<Map<string, number>> {
  if (bookingIds.length === 0) return new Map();
  const rows = await db
    .select({ bookingId: payments.bookingId, total: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int` })
    .from(payments)
    .where(
      and(
        inArray(payments.bookingId, bookingIds),
        eq(payments.status, "succeeded"),
        where === "at_studio" ? eq(payments.provider, MANUAL_PROVIDER) : undefined,
      ),
    )
    .groupBy(payments.bookingId);
  return new Map(rows.map((row) => [row.bookingId, row.total]));
}

/**
 * For several bookings at once: the extra charges added to each (overtime, cleaning, damage) and not taken back. A
 * booking with none is not in the map. See src/server/charges.ts.
 */
export async function chargesCentsByBooking(db: DbLike, bookingIds: string[]): Promise<Map<string, number>> {
  if (bookingIds.length === 0) return new Map();
  const rows = await db
    .select({ bookingId: bookingCharges.bookingId, total: sql<number>`coalesce(sum(${bookingCharges.amountCents}), 0)::int` })
    .from(bookingCharges)
    .where(and(inArray(bookingCharges.bookingId, bookingIds), isNull(bookingCharges.voidedAt)))
    .groupBy(bookingCharges.bookingId);
  return new Map(rows.map((row) => [row.bookingId, row.total]));
}
