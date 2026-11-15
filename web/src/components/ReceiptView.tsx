import { durationLabel } from "@/lib/domain/time";
import { SITE } from "@/lib/site";
import { money } from "@/server/receipt-pdf";
import { RECEIPT_STATUS_TEXT, type Receipt } from "@/server/receipts";
import { formatDay, formatInstant, formatRange } from "@/server/tz";

/**
 * One receipt on the screen, laid out to print cleanly: the studio, the
 * booking, what was booked at the prices it was booked at, and every payment
 * and refund. The PDF file is drawn from the same `Receipt`.
 */
export function ReceiptView({ receipt }: { receipt: Receipt }) {
  const when = formatRange(new Date(receipt.visitStart), new Date(receipt.visitEnd));
  return (
    <article className="receipt">
      <header className="receipt-head">
        <div>
          <strong className="receipt-studio">{SITE.name}</strong>
          <div>
            {SITE.addressLine1}, {SITE.addressLine2}
          </div>
          <div>{SITE.phoneDisplay}</div>
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
                  {refund.pending && " (on its way)"}
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
        This receipt shows what was actually paid for this booking, at the prices it was booked at. Amounts are in US
        dollars. Times are Eastern Time.
      </p>
    </article>
  );
}
