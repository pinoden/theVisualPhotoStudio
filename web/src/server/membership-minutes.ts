import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { membershipMinutes, memberships } from "@/db/schema";

/**
 * A membership's minutes (follow-up 3): every change is a line of `membership_minutes`, and what is left is their
 * sum. In a module of its own, with nothing but the database, because the booking, its hold running out and the
 * memberships all use it.
 */

/** The minutes left on a membership. */
export async function minutesLeftOf(db: DbLike, membershipId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${membershipMinutes.minutes}), 0)::int` })
    .from(membershipMinutes)
    .where(eq(membershipMinutes.membershipId, membershipId));
  return row?.total ?? 0;
}

/**
 * Take a booking's minutes off its membership, inside the transaction that holds the booking's time. The membership is
 * locked first, so that two bookings never spend the same minutes: answers false, taking nothing, when fewer minutes
 * are left now than the booking was priced with.
 */
export async function takeBookingMinutes(tx: DbLike, input: { membershipId: string; bookingId: string; minutes: number; ref: string }): Promise<boolean> {
  if (input.minutes <= 0) return true;
  await tx.select({ id: memberships.id }).from(memberships).where(eq(memberships.id, input.membershipId)).for("update");
  if ((await minutesLeftOf(tx, input.membershipId)) < input.minutes) return false;
  await tx.insert(membershipMinutes).values({
    membershipId: input.membershipId,
    minutes: -input.minutes,
    kind: "booking",
    bookingId: input.bookingId,
    note: `Booking ${input.ref}`,
    actor: "the site",
  });
  return true;
}

/**
 * Bookings that were never made (their card was refused, or their hold on the time ran out before they were paid)
 * give back the minutes they took: their lines go, as if they had never been, since no booking stood.
 */
export async function giveBackUnmadeMinutes(tx: DbLike, bookingIds: string[]): Promise<void> {
  if (bookingIds.length === 0) return;
  await tx.delete(membershipMinutes).where(and(inArray(membershipMinutes.bookingId, bookingIds), eq(membershipMinutes.kind, "booking")));
}
