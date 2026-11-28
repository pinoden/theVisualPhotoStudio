import { describe, expect, it } from "vitest";
import { quote, type BundlePrice, type PriceRule } from "./pricing";
import { bookingSale, bundlePercent, listsOnSale, salePriceCents, salesInForce, type Sale } from "./sale";

const sale = (overrides: Partial<Sale>): Sale => ({
  id: "s1",
  name: "Black Friday",
  percent: 17,
  studioIds: [],
  bookFrom: "2026-11-27",
  bookUntil: "2026-11-28",
  visitFrom: null,
  visitUntil: null,
  ...overrides,
});

describe("a sale the owners set (the owner, 2026-11-27)", () => {
  it("is in force on the days it can be booked, the first and the last included", () => {
    const blackFriday = sale({});
    expect(salesInForce([blackFriday], "2026-11-26")).toEqual([]);
    expect(salesInForce([blackFriday], "2026-11-27")).toEqual([blackFriday]);
    expect(salesInForce([blackFriday], "2026-11-28")).toEqual([blackFriday]);
    expect(salesInForce([blackFriday], "2026-11-29")).toEqual([]);
    // Whatever the day of the studio time, while the owners did not limit it.
    expect(salesInForce([blackFriday], "2026-11-27", "2027-03-01")).toEqual([blackFriday]);
  });

  it("is for studio time on the days the owners limit it to, either end open", () => {
    const weekend = sale({ visitFrom: "2026-11-27", visitUntil: "2026-11-29" });
    expect(salesInForce([weekend], "2026-11-27", "2026-11-29")).toEqual([weekend]);
    expect(salesInForce([weekend], "2026-11-27", "2026-11-30")).toEqual([]);
    // A price list, which knows no day yet, shows it.
    expect(salesInForce([weekend], "2026-11-27")).toEqual([weekend]);
    const fromDecember = sale({ visitFrom: "2026-12-01" });
    expect(salesInForce([fromDecember], "2026-11-27", "2026-11-30")).toEqual([]);
    expect(salesInForce([fromDecember], "2026-11-27", "2027-06-01")).toEqual([fromDecember]);
    const untilChristmas = sale({ visitUntil: "2026-12-24" });
    expect(salesInForce([untilChristmas], "2026-11-27", "2026-12-24")).toEqual([untilChristmas]);
    expect(salesInForce([untilChristmas], "2026-11-27", "2026-12-25")).toEqual([]);
  });

  it("takes off each studio the most any one sale takes off it: sales do not add up", () => {
    const all = sale({ percent: 10, name: "Winter" });
    const blanche = sale({ id: "s2", percent: 25, studioIds: ["blanche"] });
    expect(bookingSale([all, blanche], ["blanche", "paris"])).toEqual({ name: "Black Friday + Winter", percents: { blanche: 25, paris: 10 } });
    expect(bookingSale([blanche], ["paris"])).toBeNull();
    expect(bookingSale([blanche], ["paris", "blanche"])).toEqual({ name: "Black Friday", percents: { blanche: 25 } });
    expect(bookingSale([], ["blanche"])).toBeNull();
  });

  it("gives a price in whole dollars, never more than the usual one", () => {
    expect(salePriceCents(7800, 17)).toBe(6500); // $64.74
    expect(salePriceCents(7800, 20)).toBe(6200); // $62.40
    expect(salePriceCents(13600, 17)).toBe(11300); // $112.88
    expect(salePriceCents(7800, 0)).toBe(7800);
    expect(salePriceCents(40, 10)).toBe(0); // 36 cents: nothing, in whole dollars
    expect(salePriceCents(7850, 1)).toBe(7800); // $77.72
    expect(salePriceCents(150, 1)).toBe(100); // $1.49 rounds to $1; never above $1.50
  });

  it("lowers the price lists and keeps the usual prices; a bundle is on sale when each of its studios is", () => {
    const rules: PriceRule[] = [
      { studioId: "blanche", dayType: "weekday", durationMinutes: 60, priceCents: 7800 },
      { studioId: "blanche", dayType: "weekend", durationMinutes: 60, priceCents: 9800 },
      { studioId: "paris", dayType: "weekday", durationMinutes: 60, priceCents: 7800 },
    ];
    const bundles: BundlePrice[] = [
      { studioIds: ["blanche", "paris"], durationMinutes: 60, priceCents: 11500 },
      { studioIds: ["blanche", "paris", "dayglow"], durationMinutes: 60, priceCents: 16500 },
    ];
    expect(listsOnSale(rules, bundles, null)).toEqual({ rules, bundlePrices: bundles });
    const onlyBlanche = listsOnSale(rules, bundles, { percents: { blanche: 20 } });
    expect(onlyBlanche.rules).toEqual([
      { studioId: "blanche", dayType: "weekday", durationMinutes: 60, priceCents: 6200, usualCents: 7800 },
      { studioId: "blanche", dayType: "weekend", durationMinutes: 60, priceCents: 7800, usualCents: 9800 },
      { studioId: "paris", dayType: "weekday", durationMinutes: 60, priceCents: 7800 },
    ]);
    expect(onlyBlanche.bundlePrices).toEqual(bundles);
    // Two of the three on sale, at different rates: the pair at the lower rate, the three at none.
    expect(bundlePercent({ blanche: 20, paris: 10 }, ["blanche", "paris"])).toBe(10);
    const both = listsOnSale(rules, bundles, { percents: { blanche: 20, paris: 10 } });
    expect(both.bundlePrices).toEqual([
      { studioIds: ["blanche", "paris"], durationMinutes: 60, priceCents: 10400, usualCents: 11500 }, // $103.50 rounds up
      { studioIds: ["blanche", "paris", "dayglow"], durationMinutes: 60, priceCents: 16500 },
    ]);
  });
});

describe("a price under a sale", () => {
  const rules: PriceRule[] = [
    { studioId: "blanche", dayType: "weekday", durationMinutes: 60, priceCents: 7800 },
    { studioId: "paris", dayType: "weekday", durationMinutes: 60, priceCents: 7800 },
  ];
  const input = { dayType: "weekday" as const, durationMinutes: 60, rules, bundlePrices: [], multiStudioPercent: { 2: 20 } };

  it("lowers the studio's price, says what came off, and keeps the usual line to cross out", () => {
    expect(quote({ ...input, studioIds: ["blanche"], sale: { percents: { blanche: 17 } } })).toMatchObject({
      studioLines: [{ studioId: "blanche", priceCents: 6500 }],
      totalCents: 6500,
      saleCents: 1300,
      usualStudioLines: [{ studioId: "blanche", priceCents: 7800 }],
    });
  });

  it("says nothing of a sale that lowers nothing here, and a session is never on sale", () => {
    const elsewhere = quote({ ...input, studioIds: ["blanche"], sale: { percents: { paris: 17 } } });
    expect(elsewhere).toEqual(quote({ ...input, studioIds: ["blanche"] }));
    expect("saleCents" in elsewhere).toBe(false);
    const session = quote({ ...input, studioIds: ["blanche"], photoPackage: { priceCents: 37500 }, sale: { percents: { blanche: 17 } } });
    expect(session.totalCents).toBe(37500);
    expect("saleCents" in session).toBe(false);
  });

  it("comes off first: the discount for several studios, a code and the tax are worked out on the sale's prices", () => {
    const sale = { percents: { blanche: 25, paris: 25 } };
    const both = { ...input, studioIds: ["blanche", "paris"], promo: { kind: "percent" as const, value: 10 }, tax: { basisPoints: 650, studio: true, addons: true } };
    const priced = quote({ ...both, sale });
    // $78 less a quarter is $58.50, $59 in whole dollars; two of them, less 20% for two studios.
    expect(priced).toMatchObject({ studiosSubtotalCents: 11800, multiStudioDiscountCents: 2360 });
    // Without the sale: $156 less 20% is $124.80. With it: $94.40. So it took off $30.40.
    expect(priced.saleCents).toBe(3040);
    // The same as a price worked out on lists already lowered, with what the sale took off beside it.
    expect(priced).toEqual({ ...quote({ ...both, ...listsOnSale(rules, [], sale) }), saleCents: 3040, usualStudioLines: quote({ ...both, promo: null, tax: null }).studioLines });
  });
});
