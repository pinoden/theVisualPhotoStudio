import { asc, eq } from "drizzle-orm";
import { bookingEvents } from "@/db/schema";
import type { DbLike } from "@/db/client";
import type { LabelKey } from "@/lib/domain/labels";

/**
 * The history of a booking's status label. Every change of label writes one
 * line here, in the same transaction as the change, with who made it and when.
 */

/** Who made a change, when it was not an administrator with an address. */
export const BY_CUSTOMER = "customer";
export const BY_SYSTEM = "system";
export const BY_STUDIO = "the studio";

export interface BookingEvent {
  at: string;
  /** "new" for the line that records the booking being made. */
  from: LabelKey | "new";
  to: LabelKey;
  actor: string;
  note: string;
}

export async function recordEvent(
  tx: DbLike,
  event: { bookingId: string; from: LabelKey | "new"; to: LabelKey; actor: string; at: Date; note?: string },
): Promise<void> {
  await tx.insert(bookingEvents).values({
    bookingId: event.bookingId,
    at: event.at,
    fromLabel: event.from,
    toLabel: event.to,
    actor: event.actor,
    note: event.note ?? "",
  });
}

/**
 * A history note with its amounts taken out: "Refund $64.60" becomes "Refund
 * (amount not shown)". For a viewer who may open the appointment and may not
 * see what it cost: the note still says what happened, never how much.
 */
export function withoutAmounts(note: string): string {
  return note.replace(/-?\$\d[\d,]*(?:\.\d{1,2})?/g, "(amount not shown)");
}

/** A booking's history, oldest first. */
export async function listEvents(db: DbLike, bookingId: string): Promise<BookingEvent[]> {
  const rows = await db
    .select()
    .from(bookingEvents)
    .where(eq(bookingEvents.bookingId, bookingId))
    .orderBy(asc(bookingEvents.at), asc(bookingEvents.recordedAt));
  return rows.map((row) => ({
    at: row.at.toISOString(),
    from: row.fromLabel as BookingEvent["from"],
    to: row.toLabel as LabelKey,
    actor: row.actor,
    note: row.note,
  }));
}
