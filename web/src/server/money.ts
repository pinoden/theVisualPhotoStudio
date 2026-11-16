import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { payments, refunds } from "@/db/schema";
import type { DbLike } from "@/db/client";
import { MANUAL_PROVIDER } from "@/lib/payment-methods";

/**
 * What is held for a booking, by where the money is.
 *
 * Two kinds of payment exist. A card charged through the site sits with the
 * processor, and the site can send it back. Money taken at the studio and
 * recorded by hand ("mark as paid") never passed through the site: a refund
 * of it is the studio's to make, and to record.
 */

/** Card money still held for a booking: payments charged through the site, less refunds sent or on their way. */
export async function netCardPaidCents(db: DbLike, bookingId: string): Promise<number> {
  const viaSite = and(eq(payments.bookingId, bookingId), ne(payments.provider, MANUAL_PROVIDER));
  const [paid] = await db
    .select({ total: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int` })
    .from(payments)
    .where(and(viaSite, eq(payments.status, "succeeded")));
  const [back] = await db
    .select({ total: sql<number>`coalesce(sum(${refunds.amountCents}), 0)::int` })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .where(and(viaSite, inArray(refunds.status, ["pending", "succeeded"])));
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
