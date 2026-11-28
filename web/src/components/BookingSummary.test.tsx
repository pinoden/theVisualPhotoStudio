import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BookingView } from "@/server/bookings";
import { BookingSummary } from "./BookingSummary";

const PAID_ONLINE: BookingView = {
  id: "b1",
  ref: "VS-ABC123",
  status: "confirmed",
  cancelReason: null,
  customerName: "Ann Avery",
  customerEmail: "ann@example.com",
  startAt: "2026-12-01T15:00:00.000Z",
  endAt: "2026-12-01T17:00:00.000Z",
  durationMinutes: 120,
  studios: [{ name: "Studio Blanche", priceCents: 17600 }],
  addons: [],
  studiosSubtotalCents: 17600,
  multiStudioDiscountCents: 0,
  addonsCents: 0,
  promoDiscountCents: 0,
  creditAppliedCents: 0,
  membershipMinutes: 0,
  membershipCents: 0,
  taxCents: 0,
  taxBasisPoints: 0,
  promoKind: null,
  promoSource: null,
  label: "confirmed",
  madeByAdmin: false,
  photography: null,
  totalCents: 17600,
  charges: [],
  chargesCents: 0,
  receivedCents: 17600,
  receivedAtStudioCents: 0,
  receivedThroughAcuityCents: 0,
  dueCents: 0,
  heldCents: 0,
  creditLeftCents: 0,
  creditReturnedCents: 0,
  refundedCents: 0,
  refundsWaitingCents: 0,
  rescheduledCount: 0,
  endRequest: null,
  accepted: [],
  initialed: [],
  saleName: null,
  saleCents: 0,
};

/** The summary's last row, as its two sides read. */
function lastRow(changes: Partial<BookingView>): [string, string] {
  const html = renderToStaticMarkup(<BookingSummary booking={{ ...PAID_ONLINE, ...changes }} />);
  const match = /<div class="price-row total"><span>(.*?)<\/span><span>(.*?)<\/span><\/div>/.exec(html);
  if (!match) throw new Error(`No total row in ${html}`);
  return [match[1], match[2]];
}

describe("a booking's summary", () => {
  it("shows sales tax as a line of its own: after a discount, before the credit that pays for it", () => {
    const rows = (changes: Partial<BookingView>) =>
      [...renderToStaticMarkup(<BookingSummary booking={{ ...PAID_ONLINE, ...changes }} />).matchAll(/<div class="price-row[^"]*"><span>([^<]*)<\/span><span>([^<]*)<\/span><\/div>/g)].map(
        (row) => `${row[1]} ${row[2]}`,
      );
    expect(rows({}).join("|")).not.toContain("Sales tax");
    const taxed = { taxCents: 1144, taxBasisPoints: 650, totalCents: 18744, receivedCents: 18744 };
    expect(rows(taxed)).toEqual(["Studio Blanche $176", "Sales tax (6.5%) $11.44", "Charged to card $187.44"]);
    expect(rows({ ...taxed, promoKind: "percent", promoDiscountCents: 1760, taxCents: 1030, totalCents: 16870, receivedCents: 16870 })).toEqual([
      "Studio Blanche $176",
      "Discount code -$17.60",
      "Sales tax (6.5%) $10.30",
      "Charged to card $168.70",
    ]);
    expect(rows({ ...taxed, promoKind: "amount", promoSource: "manual", promoDiscountCents: 10000, creditAppliedCents: 10000, totalCents: 8744, receivedCents: 8744 })).toEqual([
      "Studio Blanche $176",
      "Sales tax (6.5%) $11.44",
      "Paid with studio credit -$100",
      "Charged to card $87.44",
    ]);
  });

  it("says where the money came from, or what is still to pay", () => {
    expect(lastRow({})).toEqual(["Charged to card", "$176"]);
    // Taking the amount did not go through yet: the card holds it, and it is not charged.
    expect(lastRow({ receivedCents: 0, heldCents: 17600 })).toEqual(["Held on card", "$176"]);
    // The reservation lapsed: the booking owes its price.
    expect(lastRow({ receivedCents: 0, dueCents: 17600 })).toEqual(["To pay", "$176"]);
    expect(lastRow({ madeByAdmin: true, receivedCents: 0, dueCents: 17600 })).toEqual(["To pay at the studio", "$176"]);
    expect(lastRow({ receivedAtStudioCents: 17600 })).toEqual(["Paid at the studio", "$176"]);
    expect(lastRow({ receivedAtStudioCents: 5000 })).toEqual(["Paid by card and at the studio", "$176"]);
    expect(lastRow({ madeByAdmin: true })).toEqual(["Paid by card", "$176"]);
    // A booking that ended shows what it cost.
    expect(lastRow({ status: "cancelled", receivedCents: 0 })).toEqual(["Total", "$176"]);
  });

  it("says that a booking imported from Acuity was paid there, not at the studio", () => {
    const imported = { madeByAdmin: true, receivedAtStudioCents: 0 };
    expect(lastRow({ ...imported, receivedThroughAcuityCents: 17600 })).toEqual(["Paid through Acuity", "$176"]);
    // What was left was paid at the studio, or by card through a payment link.
    expect(lastRow({ ...imported, receivedThroughAcuityCents: 5000, receivedAtStudioCents: 12600 })).toEqual(["Paid through Acuity and at the studio", "$176"]);
    expect(lastRow({ ...imported, receivedThroughAcuityCents: 5000 })).toEqual(["Paid through Acuity and by card", "$176"]);
    // Still owing: what was paid is "so far", whatever paid it, and the rest is paid at the studio.
    const html = renderToStaticMarkup(
      <BookingSummary booking={{ ...PAID_ONLINE, ...imported, receivedCents: 5000, receivedThroughAcuityCents: 5000, dueCents: 12600 }} />,
    );
    expect(html).toContain("<span>Paid so far</span><span>$50</span>");
    expect(lastRow({ ...imported, receivedCents: 5000, receivedThroughAcuityCents: 5000, dueCents: 12600 })).toEqual(["To pay at the studio", "$126"]);
  });

  it("says what a missed booking still owes, as its payment card does", () => {
    expect(lastRow({ status: "no_show", receivedCents: 0, dueCents: 17600 })).toEqual(["To pay", "$176"]);
    expect(lastRow({ status: "no_show", madeByAdmin: true, receivedCents: 5000, dueCents: 12600 })).toEqual(["To pay at the studio", "$126"]);
    expect(lastRow({ status: "no_show" })).toEqual(["Charged to card", "$176"]);
  });

  it("says what was paid and what is to be refunded, once a move made the booking cost less (follow-up 5)", () => {
    // $176 paid; moved to a day where it costs $168.
    const moved = { studios: [{ name: "Studio Blanche", priceCents: 16800 }], studiosSubtotalCents: 16800, totalCents: 16800, creditLeftCents: 800 };
    expect(lastRow(moved)).toEqual(["To be refunded", "$8"]);
    const html = renderToStaticMarkup(<BookingSummary booking={{ ...PAID_ONLINE, ...moved }} />);
    expect(html).toContain('<div class="price-row"><span>Charged to card</span><span>$176</span></div>');
    expect(lastRow({ ...moved, receivedAtStudioCents: 17600 })).toEqual(["To be refunded", "$8"]);
    // Once it ended, it shows what it cost: a cancellation dealt with the money.
    expect(lastRow({ ...moved, status: "cancelled" })).toEqual(["Total", "$168"]);
  });

  // The owners' decision of 2026-11-20: the original payment, what was refunded, what was paid in the end, and any
  // balance due or credit left, the credit apart from what was refunded.
  it("says what was paid, what was refunded and what that leaves, once money was given back", () => {
    const html = (changes: Partial<BookingView>) => renderToStaticMarkup(<BookingSummary booking={{ ...PAID_ONLINE, ...changes }} />);
    // A goodwill refund of $50 on a booking that stands.
    const goodwill = { refundedCents: 5000 };
    expect(html(goodwill)).toContain('<div class="price-row"><span>Charged to card</span><span>$176</span></div>');
    expect(html(goodwill)).toContain('<div class="price-row price-discount"><span>Refunded</span><span>-$50</span></div>');
    expect(lastRow(goodwill)).toEqual(["Paid, less refunds", "$126"]);
    // A cancellation refunded less its 5% fee, the refund not on the card yet; then made.
    const cancelled = { status: "cancelled", refundedCents: 16720, refundsWaitingCents: 16720 };
    expect(html(cancelled)).toContain("<span>Refund on its way</span><span>-$167.20</span>");
    expect(lastRow(cancelled)).toEqual(["Paid, less refunds", "$8.80"]);
    expect(html({ ...cancelled, refundsWaitingCents: 0 })).toContain("<span>Refunded</span><span>-$167.20</span>");
    expect(html({ ...cancelled, refundsWaitingCents: 6720 })).toContain("<span>Refunded (part on its way)</span><span>-$167.20</span>");
    // Moved to a day that costs $168: $8 of credit left, apart from a $20 goodwill refund already made.
    const moved = { studios: [{ name: "Studio Blanche", priceCents: 16800 }], studiosSubtotalCents: 16800, totalCents: 16800, creditLeftCents: 800, refundedCents: 2000 };
    expect(html(moved)).toContain("<span>Refunded</span><span>-$20</span>");
    expect(lastRow(moved)).toEqual(["To be refunded", "$8"]);
    // That credit refunded: nothing left to refund.
    expect(lastRow({ ...moved, creditLeftCents: 0, refundedCents: 2800, creditReturnedCents: 800 })).toEqual(["Paid, less refunds", "$148"]);
    // Still owing: what is due stays the last row, after what was paid and refunded.
    const owing = { madeByAdmin: true, receivedCents: 10000, receivedAtStudioCents: 10000, refundedCents: 1000, dueCents: 7600 };
    expect(html(owing)).toContain("<span>Paid at the studio</span><span>$100</span>");
    expect(html(owing)).not.toContain("so far");
    expect(lastRow(owing)).toEqual(["To pay at the studio", "$76"]);
    // Nothing was paid: no refund rows, whatever the view says.
    expect(html({ receivedCents: 0, refundedCents: 0, status: "cancelled" })).not.toContain("Refunded");
  });
});
