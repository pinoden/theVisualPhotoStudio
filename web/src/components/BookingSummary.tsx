import { formatCents } from "@/lib/domain/pricing";
import { durationLabel } from "@/lib/domain/time";
import type { BookingView } from "@/server/bookings";
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
  const paidStatus = booking.status === "confirmed" || booking.status === "completed";
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
          <span>{studio.name}</span>
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
          <span>{booking.creditAppliedCents > 0 ? "Paid with reschedule code" : "Discount code"}</span>
          <span>{formatCents(-booking.promoDiscountCents)}</span>
        </div>
      )}
      <div className="price-row total">
        <span>{paidStatus ? "Charged to card" : "Total"}</span>
        <span>{formatCents(booking.totalCents)}</span>
      </div>
    </div>
  );
}
