import { durationLabel } from "@/lib/domain/time";
import type { Business } from "@/lib/site/frame";
import { money } from "@/server/receipt-pdf";
import { RECEIPT_STATUS_TEXT, REFUND_STATE_WORDS, type Receipt } from "@/server/receipts";
import { formatDay, formatInstant, formatRange } from "@/server/tz";

/**
 * One receipt on the screen, laid out to print cleanly: the studio, the
 * booking, what was booked at its prices (its new day's after a move that
 * priced it again), and every payment and refund. The PDF file is drawn from
 * the same `Receipt`.
 */
export function ReceiptView({ receipt, business }: { receipt: Receipt; business: Business }) {
  const when = formatRange(new Date(receipt.visitStart), new Date(receipt.visitEnd));
  return (
    <article className="receipt">
      <header className="receipt-head">
        <div>
          <strong className="receipt-studio">{business.name}</strong>
          <div>
            {business.addressLine1}, {business.addressLine2}
          </div>
          <div>{business.phone}</div>
        </div>
        <div className="receipt-title">Receipt</div>
      </header>

      <dl className="detail-list">
        <dt>Booking</dt>
        <dd>{receipt.ref}</dd>
        <dt>Paid</dt>
        <dd>{formatDay(new Date(receipt.paidAt))}</dd>
        <dt>Customer</dt>
        <dd>
          {receipt.customerName}, {receipt.customerEmail}
        </dd>
        <dt>Appointment</dt>
        <dd>
          {when.day}, {when.time} ({durationLabel(receipt.durationMinutes)})
        </dd>
        <dt>Studio</dt>
        <dd>
          {receipt.studios}
          {receipt.photography && ", photography session"}
        </dd>
        <dt>Booking status</dt>
        <dd>{receipt.bookingStatus}</dd>
      </dl>

      <h3>What was booked</h3>
      <div className="price-summary">
        {receipt.lines.map((line, index) => (
          <div className={`price-row${line.cents < 0 ? " price-discount" : ""}`} key={index}>
            <span>{line.label}</span>
            <span>{money(line.cents)}</span>
          </div>
        ))}
        <div className="price-row total">
          <span>Total</span>
          <span>{money(receipt.totalCents)}</span>
        </div>
      </div>

      <h3>Payments</h3>
      <div className="price-summary">
        {receipt.payments.map((payment) => (
          <div key={payment.id}>
            <div className="price-row">
              <span>
                {formatInstant(new Date(payment.at))}
                <br />
                <small>{payment.how}</small>
              </span>
              <span>{money(payment.amountCents)}</span>
            </div>
            {payment.refunds.map((refund, index) => (
              <div className="price-row price-discount" key={index}>
                <span>
                  Refund {formatDay(new Date(refund.at))}
                  {REFUND_STATE_WORDS[refund.state]}
                  {refund.reason && (
                    <>
                      <br />
                      <small>{refund.reason}</small>
                    </>
                  )}
                </span>
                <span>{money(-refund.amountCents)}</span>
              </div>
            ))}
          </div>
        ))}
        <div className="price-row total">
          <span>Paid</span>
          <span>{money(receipt.paidCents)}</span>
        </div>
        {receipt.refundedCents > 0 && (
          <>
            <div className="price-row">
              <span>Refunded</span>
              <span>{money(-receipt.refundedCents)}</span>
            </div>
            <div className="price-row total">
              <span>Paid, less refunds</span>
              <span>{money(receipt.netCents)}</span>
            </div>
          </>
        )}
        {receipt.dueCents > 0 && (
          <div className="price-row">
            <span>Still to pay</span>
            <span>{money(receipt.dueCents)}</span>
          </div>
        )}
        <div className="price-row">
          <span>Payment status</span>
          <span>{RECEIPT_STATUS_TEXT[receipt.status]}</span>
        </div>
      </div>
      <p className="receipt-foot">
        {/* Its prices are the new day's when the studio moved it to a day priced differently (follow-up 5). */}
        This receipt shows the booking at its prices, and what was actually paid and given back for it. Amounts are in
        US dollars. Times are Eastern Time.
      </p>
    </article>
  );
}
