import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loyaltyStanding } from "@/lib/domain/loyalty";
import { atAGlance, visitStamps } from "@/server/account";
import { BalanceFacts, LoyaltyFacts } from "./AtAGlance";
import { VisitStamp, VisitStampBadge } from "./VisitStamp";

/** What clients see of their loyalty and balance (the owner's answer of 2026-11-23, question 72). */
describe("a client's loyalty and balance, at a glance", () => {
  const rewards = [
    { status: "available" as const, expiresAt: "2027-03-01T05:00:00.000Z" },
    { status: "available" as const, expiresAt: "2027-01-15T05:00:00.000Z" },
    { status: "redeemed" as const, expiresAt: "2026-12-01T05:00:00.000Z" },
    { status: "expired" as const, expiresAt: "2026-10-01T05:00:00.000Z" },
  ];
  const codes = [
    { kind: "amount" as const, value: 6800, photographyOnly: false },
    { kind: "amount" as const, value: 3200, photographyOnly: false },
    { kind: "amount" as const, value: 5000, photographyOnly: true },
    { kind: "percent" as const, value: 20, photographyOnly: false },
    { kind: "free_hour" as const, value: 60, photographyOnly: false },
  ];
  const memberships = [
    { status: "active" as const, minutesLeft: 210 },
    { status: "starting" as const, minutesLeft: 300 },
  ];

  it("adds up the free hours to use, the credit and the membership's hours", () => {
    expect(atAGlance(rewards, codes, memberships)).toEqual({
      freeHours: 2,
      firstFreeHourEnds: "2027-01-15T05:00:00.000Z",
      creditCents: 10000,
      photoCreditCents: 5000,
      discounts: 1,
      membershipMinutes: 210, // one still being bought gives nothing yet
    });
    expect(atAGlance([], [], [])).toEqual({ freeHours: 0, firstFreeHourEnds: null, creditCents: 0, photoCreditCents: 0, discounts: 0, membershipMinutes: 0 });
  });

  it("shows the stamps, the free hours and the balance in words", () => {
    const standing = loyaltyStanding(
      Array.from({ length: 7 }, (_, index) => ({ bookingId: `b${index}`, day: `2026-10-${String(index + 1).padStart(2, "0")}`, startAt: index, usedFreeHour: false, photography: false })),
      5,
    );
    const loyalty = renderToStaticMarkup(<LoyaltyFacts standing={standing} glance={atAGlance(rewards, codes, memberships)} />);
    expect(loyalty).toContain("<dt>Stamps collected</dt><dd>7</dd>");
    expect(loyalty).toContain("<dt>Free hours earned</dt><dd>1</dd>");
    expect(loyalty).toContain("<dt>Free hours to use</dt><dd>2, the first until Jan 15, 2027</dd>");

    const balance = renderToStaticMarkup(<BalanceFacts glance={atAGlance(rewards, codes, memberships)} member />);
    for (const words of ["<dt>Studio credit</dt><dd>$100</dd>", "<dt>Photography credit</dt><dd>$50</dd>", "<dt>Discount codes</dt><dd>1</dd>", "<dt>Membership hours left</dt><dd>3.5 hours</dd>"]) {
      expect(balance).toContain(words);
    }
    // Nothing to say: nothing is drawn.
    expect(renderToStaticMarkup(<BalanceFacts glance={atAGlance([], [], [])} member={false} />)).toBe("");
    expect(renderToStaticMarkup(<BalanceFacts glance={atAGlance([], [], [])} member />)).toContain("<dt>Membership hours left</dt><dd>None</dd>");
  });

  it("marks each past visit that gave a stamp, and the one that completed a free hour", () => {
    const standing = loyaltyStanding(
      ["b1", "b2", "b3", "b4", "b5", "b6"].map((bookingId, index) => ({ bookingId, day: `2026-10-0${index + 1}`, startAt: index, usedFreeHour: false, photography: false })),
      5,
    );
    const stamps = visitStamps(standing);
    expect(renderToStaticMarkup(<VisitStamp bookingId="b2" stamps={stamps} />)).toContain("This visit earned a loyalty stamp.");
    expect(renderToStaticMarkup(<VisitStamp bookingId="b5" stamps={stamps} />)).toContain("This visit earned a loyalty stamp, and completed a free studio hour.");
    expect(renderToStaticMarkup(<VisitStampBadge bookingId="b6" stamps={stamps} />)).toContain("Stamp earned");
    // A visit with no stamp (another booking of a day already counted, a photography session), or loyalty switched off.
    expect(renderToStaticMarkup(<VisitStamp bookingId="b9" stamps={stamps} />)).toBe("");
    expect(renderToStaticMarkup(<VisitStampBadge bookingId="b9" stamps={stamps} />)).toBe("");
    expect(renderToStaticMarkup(<VisitStamp bookingId="b1" stamps={visitStamps(null)} />)).toBe("");
  });
});
