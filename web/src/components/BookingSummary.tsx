import { formatCents } from "@/lib/domain/pricing";
import { durationLabel } from "@/lib/domain/time";
import type { BookingView } from "@/server/bookings";
import { STANDS } from "@/server/money";
import { formatRange } from "@/server/tz";

export const STATUS_LABEL: Record<string, string> = {
  confirmed: "Confirmed",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "Missed",
  pending_payment: "Payment in progress",
  expired: "Not completed",
};

export function statusLabel(booking: Pick<BookingView, "status" | "cancelReason">): string {
  if (booking.status === "cancelled" && booking.cancelReason === "rescheduled") return "Released for rescheduling";
  return STATUS_LABEL[booking.status] ?? booking.status;
}

/** When, where and what it cost. Server component: times are shown in studio time. */
export function BookingSummary({ booking }: { booking: BookingView }) {
  const when = formatRange(new Date(booking.startAt), new Date(booking.endAt));
  // A booking that stands, missed ones included, is paid or owes; one that ended shows what it cost.
  const paidStatus = STANDS.includes(booking.status);
  /** What came by card: online, or through a payment link. */
  const byCard = booking.receivedCents - booking.receivedAtStudioCents;
  return (
    <div className="price-summary">
      <div className="price-row">
        <span>Date</span>
        <strong>{when.day}</strong>
      </div>
      <div className="price-row">
        <span>Time</span>
        <strong>
          {when.time} ({durationLabel(booking.durationMinutes)})
        </strong>
      </div>
      {booking.studios.map((studio) => (
        <div className="price-row" key={studio.name}>
          <span>
            {booking.photography && "Photography session, "}
            {studio.name}
            {booking.photography && (
              <>
                <br />
                <small>
                  With our in-house photographer, studio included
                  {booking.photography.includes ? `. ${booking.photography.includes}` : ""}.
                </small>
              </>
            )}
          </span>
          <span>{formatCents(studio.priceCents)}</span>
        </div>
      ))}
      {booking.multiStudioDiscountCents > 0 && (
        <div className="price-row price-discount">
          <span>Multi-studio discount</span>
          <span>{formatCents(-booking.multiStudioDiscountCents)}</span>
        </div>
      )}
      {/* By position: two add-ons can share a name (a pet fee for each of two studios). */}
      {booking.addons.map((addon, index) => (
        <div className="price-row" key={index}>
          <span>
            {addon.name}
            {addon.quantity > 1 ? ` × ${addon.quantity}` : ""}
          </span>
          <span>{formatCents(addon.unitCents * addon.quantity)}</span>
        </div>
      ))}
      {booking.promoDiscountCents > 0 && (
        <div className="price-row price-discount">
          <span>
            {booking.creditAppliedCents > 0
              ? booking.promoSource === "reschedule"
                ? "Paid with reschedule code"
                : "Paid with studio credit"
              : booking.promoKind === "free_hour"
                ? "Free hour"
                : "Discount code"}
          </span>
          <span>{formatCents(-booking.promoDiscountCents)}</span>
        </div>
      )}
      {/* Added once the appointment started: overtime, cleaning, damage (src/server/charges.ts). */}
      {booking.charges.map((charge, index) => (
        <div className="price-row" key={`charge-${index}`}>
          <span>{charge.label}</span>
          <span>{formatCents(charge.cents)}</span>
        </div>
      ))}
      {/* A booking paid in parts (made in the admin, or one whose card was never charged): what was received, then what is owed. */}
      {paidStatus && booking.receivedCents > 0 && booking.dueCents > 0 && (
        <div className="price-row">
          <span>{byCard > 0 ? "Paid so far" : "Paid at the studio so far"}</span>
          <span>{formatCents(booking.receivedCents)}</span>
        </div>
      )}
      <div className="price-row total">
        <span>
          {/* A booking made online owes only when the amount its card held lapsed before it was taken. While the card
              holds it, it is not charged yet: taking it did not go through, and is tried again. */}
          {!paidStatus || booking.totalCents + booking.chargesCents === 0
            ? "Total"
            : booking.dueCents > 0
              ? booking.madeByAdmin
                ? "To pay at the studio"
                : "To pay"
              : booking.heldCents > 0
                ? "Held on card"
                : booking.receivedAtStudioCents > 0
                ? byCard > 0
                  ? "Paid by card and at the studio"
                  : "Paid at the studio"
                : booking.madeByAdmin
                  ? "Paid by card"
                  : "Charged to card"}
        </span>
        <span>{formatCents(paidStatus && booking.dueCents > 0 ? booking.dueCents : booking.totalCents + booking.chargesCents)}</span>
      </div>
    </div>
  );
}
