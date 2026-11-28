import { describe, expect, it } from "vitest";
import { quote, type BundlePrice, type PriceRule } from "./pricing";
import { bookingSale, bundlePercent, listsOnSale, saleCodesWords, salePriceCents, salesInForce, type Sale } from "./sale";

const sale = (overrides: Partial<Sale>): Sale => ({
  id: "s1",
  name: "Black Friday",
  percent: 17,
  studioIds: [],
  bookFrom: "2026-11-27",
  bookUntil: "2026-11-28",
  visitFrom: null,
  visitUntil: null,
  withCodes: false,
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

  it("comes off first: the discount for several studios, the tax, and a code where the owners let one go with the sale, are worked out on the sale's prices", () => {
    const sale = { percents: { blanche: 25, paris: 25 }, withCodes: true as const };
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

describe("a sale and a discount code (the owner, 2026-11-28: \"Either or, not combine\")", () => {
  const rules: PriceRule[] = [
    { studioId: "blanche", dayType: "weekday", durationMinutes: 60, priceCents: 7800 },
    { studioId: "paris", dayType: "weekday", durationMinutes: 60, priceCents: 7800 },
  ];
  const input = { studioIds: ["blanche"], dayType: "weekday" as const, durationMinutes: 60, rules, bundlePrices: [], multiStudioPercent: { 2: 20 } };
  // 17% off $78 is $65, in whole dollars.
  const sale = { percents: { blanche: 17 } };
  const percent = (value: number) => ({ kind: "percent" as const, value });

  it("charges the sale's price when the code would take off less, and the code is not used", () => {
    const priced = quote({ ...input, sale, promo: percent(10) });
    expect(priced).toMatchObject({ totalCents: 6500, saleCents: 1300, promoDiscountCents: 0, promoMisfit: "sale" });
    expect("saleSetAside" in priced).toBe(false);
    // The same as the sale's price with no code at all.
    expect({ ...priced, promoMisfit: null }).toEqual(quote({ ...input, sale }));
  });

  it("charges the usual price with the code when the code takes off more, and the sale is set aside", () => {
    // A quarter off $78 leaves $58.50, less than $65.
    const priced = quote({ ...input, sale, promo: percent(25) });
    expect(priced).toMatchObject({ studioLines: [{ studioId: "blanche", priceCents: 7800 }], promoDiscountCents: 1950, totalCents: 5850, promoMisfit: null, saleSetAside: true });
    expect("saleCents" in priced).toBe(false);
    expect("usualStudioLines" in priced).toBe(false);
    // The same as the code's price with no sale at all.
    expect(priced).toEqual({ ...quote({ ...input, promo: percent(25) }), saleSetAside: true });
  });

  it("keeps the sale's price, and the code for another day, when the two leave the same to pay", () => {
    // Half off $78 either way.
    expect(quote({ ...input, sale: { percents: { blanche: 50 } }, promo: percent(50) })).toMatchObject({ totalCents: 3900, saleCents: 3900, promoDiscountCents: 0, promoMisfit: "sale" });
  });

  it("counts a free hour as a discount code, and compares what is left to pay with the tax", () => {
    // The hour is free with the code: nothing to pay, where the sale would leave $65.
    expect(quote({ ...input, sale, promo: { kind: "free_hour", value: 60 } })).toMatchObject({ totalCents: 0, promoDiscountCents: 7800, saleSetAside: true });
    const taxed = quote({ ...input, sale, promo: percent(10), tax: { basisPoints: 650, studio: true, addons: true } });
    // $65 and its tax, against $70.20 and its tax.
    expect(taxed).toMatchObject({ totalCents: 6923, taxCents: 423, promoMisfit: "sale" });
  });

  it("lets credit and membership hours pay a sale's price like any other: they are payment, not a discount", () => {
    expect(quote({ ...input, sale, promo: { kind: "amount", value: 5000 } })).toMatchObject({ totalCents: 1500, saleCents: 1300, promoDiscountCents: 5000, promoMisfit: null });
    expect(quote({ ...input, sale, membership: { minutesLeft: 30, weekendDifference: false } })).toMatchObject({ totalCents: 3250, saleCents: 1300, membershipCents: 3250 });
  });

  it("says why a code does not fit before it says anything of the sale, and leaves a code alone where the sale lowers nothing", () => {
    const weekdays = { from: null, until: null, weekdays: [1, 2, 3, 4, 5], notOnSpecialDates: false };
    // 2026-12-12 is a Saturday.
    expect(quote({ ...input, sale, promo: { ...percent(25), days: weekdays }, bookingDay: { date: "2026-12-12", special: false } })).toMatchObject({ totalCents: 6500, promoMisfit: "day" });
    // Paris is on sale, Blanche is booked: the code works as ever.
    expect(quote({ ...input, sale: { percents: { paris: 17 } }, promo: percent(10) })).toEqual(quote({ ...input, promo: percent(10) }));
  });

  it("takes a code on top of a sale the owners ticked for it, when every sale that lowers the booking's studios is ticked", () => {
    expect(quote({ ...input, sale: { ...sale, withCodes: true }, promo: percent(10) })).toMatchObject({ totalCents: 5850, saleCents: 1300, promoDiscountCents: 650, promoMisfit: null });
    const open = { id: "s1", name: "Quiet week", percent: 10, studioIds: ["blanche"], bookFrom: "2026-11-27" as const, bookUntil: "2026-11-28" as const, visitFrom: null, visitUntil: null, withCodes: true };
    const closed = { ...open, id: "s2", name: "Black Friday", percent: 17, studioIds: ["paris"], withCodes: false };
    expect(bookingSale([open, closed], ["blanche"])).toEqual({ name: "Quiet week", percents: { blanche: 10 }, withCodes: true });
    expect(bookingSale([open, closed], ["blanche", "paris"])).toEqual({ name: "Quiet week + Black Friday", percents: { blanche: 10, paris: 17 } });
    expect(bookingSale([open, closed], ["paris"])).toEqual({ name: "Black Friday", percents: { paris: 17 } });
  });

  it("tells clients on the sale's line, unless a code can go with it", () => {
    expect(saleCodesWords({ withCodes: false })).toBe(" A discount code cannot be combined with it.");
    expect(saleCodesWords({ withCodes: true })).toBe("");
  });
});
