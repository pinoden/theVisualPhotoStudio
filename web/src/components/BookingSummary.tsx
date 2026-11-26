import { formatCents, studioPriceLines, taxLabel } from "@/lib/domain/pricing";
import { SERVICE_WORDS } from "@/lib/domain/services";
import { durationLabel } from "@/lib/domain/time";
import { listInWords } from "@/lib/words";
import type { BookingView } from "@/server/bookings";
import { STANDS } from "@/server/money";
import { formatRange } from "@/server/tz";

const STATUS_LABEL: Record<string, string> = {
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
  /** What was paid in Acuity, the old website's booking system, before the booking was imported from it. */
  const throughAcuity = booking.receivedThroughAcuityCents;
  /** What came by card: online, or through a payment link. */
  const byCard = booking.receivedCents - booking.receivedAtStudioCents - throughAcuity;
  /** How a booking that owes nothing was paid. */
  const paidHow =
    booking.heldCents > 0
      ? "Held on card"
      : throughAcuity > 0
        ? `Paid ${listInWords(["through Acuity", ...(byCard > 0 ? ["by card"] : []), ...(booking.receivedAtStudioCents > 0 ? ["at the studio"] : [])])}`
        : booking.receivedAtStudioCents > 0
          ? byCard > 0
            ? "Paid by card and at the studio"
            : "Paid at the studio"
          : booking.madeByAdmin
            ? "Paid by card"
            : "Charged to card";
  /** Paid beyond what it costs now, after a move to a day that costs less (follow-up 5): the studio refunds it. */
  const creditLeft = paidStatus ? booking.creditLeftCents : 0;
  /**
   * Money given back, for whatever reason (the owners' payment summary of 2026-11-20): what was paid, what was refunded,
   * and what that leaves, apart from a credit not yet refunded, which keeps its own row.
   */
  const refunded = booking.receivedCents > 0 ? booking.refundedCents : 0;
  const refundedLabel =
    booking.refundsWaitingCents <= 0 ? "Refunded" : booking.refundsWaitingCents >= refunded ? "Refund on its way" : "Refunded (part on its way)";
  const credit = booking.creditAppliedCents > 0;
  const codeLine = booking.promoDiscountCents > 0 && (
    <div className="price-row price-discount">
      <span>
        {credit ? (booking.promoSource === "reschedule" ? "Paid with reschedule code" : "Paid with studio credit") : booking.promoKind === "free_hour" ? "Free hour" : "Discount code"}
      </span>
      <span>{formatCents(-booking.promoDiscountCents)}</span>
    </div>
  );
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
      {studioPriceLines(booking.studios, booking.multiStudioDiscountCents).map((studio) => (
        <div className="price-row" key={studio.name}>
          <span>
            {booking.photography && `${SERVICE_WORDS[booking.photography.service].Session}, `}
            {studio.name}
            {booking.photography && (
              <>
                <br />
                <small>
                  {SERVICE_WORDS[booking.photography.service].withPerson.replace(/^w/, "W")}, studio included
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
      {/* A discount comes off before the tax. Credit is money paid before: it pays the total, tax included. */}
      {!credit && codeLine}
      {booking.membershipCents > 0 && (
        <div className="price-row price-discount">
          <span>Membership hours ({durationLabel(booking.membershipMinutes)})</span>
          <span>{formatCents(-booking.membershipCents)}</span>
        </div>
      )}
      {booking.taxCents > 0 && (
        <div className="price-row price-tax">
          <span>{taxLabel(booking.taxBasisPoints)}</span>
          <span>{formatCents(booking.taxCents)}</span>
        </div>
      )}
      {credit && codeLine}
      {/* Added once the appointment started: overtime, cleaning, damage (src/server/charges.ts). */}
      {booking.charges.map((charge, index) => (
        <div className="price-row" key={`charge-${index}`}>
          <span>{charge.label}</span>
          <span>{formatCents(charge.cents)}</span>
        </div>
      ))}
      {/* A booking paid in parts (made in the admin, or one whose card was never charged): what was received, then what is owed. */}
      {refunded === 0 && paidStatus && booking.receivedCents - booking.creditReturnedCents > 0 && booking.dueCents > 0 && (
        <div className="price-row">
          <span>{byCard > 0 || throughAcuity > 0 ? "Paid so far" : "Paid at the studio so far"}</span>
          {/* Toward its price: what was given back of a payment beyond it does not count (follow-up 5). */}
          <span>{formatCents(booking.receivedCents - booking.creditReturnedCents)}</span>
        </div>
      )}
      {refunded === 0 && creditLeft > 0 && (
        <div className="price-row">
          <span>{paidHow}</span>
          <span>{formatCents(booking.totalCents + booking.chargesCents + creditLeft)}</span>
        </div>
      )}
      {/* Something was given back: what was paid, then what was refunded. The last row says what that leaves. */}
      {refunded > 0 && (
        <>
          <div className="price-row">
            <span>{paidHow}</span>
            <span>{formatCents(booking.receivedCents)}</span>
          </div>
          <div className="price-row price-discount">
            <span>{refundedLabel}</span>
            <span>{formatCents(-refunded)}</span>
          </div>
        </>
      )}
      <div className="price-row total">
        <span>
          {/* A booking made online owes only when the amount its card held lapsed before it was taken. While the card
              holds it, it is not charged yet: taking it did not go through, and is tried again. */}
          {creditLeft > 0
            ? "To be refunded"
            : paidStatus && booking.dueCents > 0 && booking.totalCents + booking.chargesCents > 0
              ? booking.madeByAdmin
                ? "To pay at the studio"
                : "To pay"
              : refunded > 0
                ? "Paid, less refunds"
                : !paidStatus || booking.totalCents + booking.chargesCents === 0
                  ? "Total"
                  : paidHow}
        </span>
        <span>
          {formatCents(
            creditLeft > 0
              ? creditLeft
              : paidStatus && booking.dueCents > 0 && booking.totalCents + booking.chargesCents > 0
                ? booking.dueCents
                : refunded > 0
                  ? booking.receivedCents - refunded
                  : booking.totalCents + booking.chargesCents,
          )}
        </span>
      </div>
    </div>
  );
}
