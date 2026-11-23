import type { VisitStamps } from "@/server/account";

/**
 * What a past visit gave in loyalty (the owner's answer of 2026-11-23, question 72): its stamp, and the free hour it
 * completed. Only a completed visit counts, a little after it ends; one day gives one stamp, whatever its bookings.
 */
export function VisitStamp({ bookingId, stamps }: { bookingId: string; stamps: VisitStamps | null }) {
  if (!stamps?.stamped.has(bookingId)) return null;
  return (
    <p className="visit-stamp">
      <span aria-hidden="true">✓ </span>
      {stamps.completed.has(bookingId) ? "This visit earned a loyalty stamp, and completed a free studio hour." : "This visit earned a loyalty stamp."}
    </p>
  );
}

/** The same, as a badge beside the visit's date in the list. */
export function VisitStampBadge({ bookingId, stamps }: { bookingId: string; stamps: VisitStamps | null }) {
  return stamps?.stamped.has(bookingId) ? <span className="stamp-badge">Stamp earned</span> : null;
}
