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
  rescheduledCount: 0,
  endRequest: null,
};

/** The summary's last row, as its two sides read. */
function lastRow(changes: Partial<BookingView>): [string, string] {
  const html = renderToStaticMarkup(<BookingSummary booking={{ ...PAID_ONLINE, ...changes }} />);
  const match = /<div class="price-row total"><span>(.*?)<\/span><span>(.*?)<\/span><\/div>/.exec(html);
  if (!match) throw new Error(`No total row in ${html}`);
  return [match[1], match[2]];
}

describe("a booking's summary", () => {
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
});
