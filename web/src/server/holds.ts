import { inArray } from "drizzle-orm";
import { photographerHolds, studioHolds } from "@/db/schema";
import type { DbLike } from "@/db/client";

/**
 * Free everything bookings hold: their studios, and the photographer of a
 * photography session. Called wherever a booking stops being active
 * (cancelled, released for a reschedule code, never paid for), so that a
 * photographer is never left held by a booking that no longer exists.
 */
export async function releaseHolds(tx: DbLike, bookingIds: string | string[]): Promise<void> {
  const ids = Array.isArray(bookingIds) ? bookingIds : [bookingIds];
  if (ids.length === 0) return;
  await tx.update(studioHolds).set({ active: false }).where(inArray(studioHolds.bookingId, ids));
  await tx.update(photographerHolds).set({ active: false }).where(inArray(photographerHolds.bookingId, ids));
}
