import { describe, expect, it } from "vitest";
import {
  betweenLengths,
  bookableDurations,
  bundleKey,
  bundleList,
  bundlePricesWithBetween,
  extraGuestsAllowed,
  findPrice,
  formatCents,
  multiStudioPercentFor,
  PricingError,
  promoMisfitText,
  quote,
  rulesWithBetween,
  studioPriceLines,
  unpriced,
  type AddonDef,
  type BundlePrice,
  type PriceRule,
  type PromoDef,
} from "./pricing";

const B = "blanche";
const D = "dayglow";
const P = "paris";

function tiers(studioId: string, dayType: "weekday" | "weekend", table: Record<number, number>): PriceRule[] {
  return Object.entries(table).map(([minutes, dollars]) => ({
    studioId,
    dayType,
    durationMinutes: Number(minutes),
    priceCents: dollars * 100,
  }));
}

const rules: PriceRule[] = [
  ...tiers(B, "weekday", { 60: 88, 120: 176, 240: 320, 600: 720 }),
  ...tiers(D, "weekday", { 60: 78, 120: 156, 240: 285 }),
  ...tiers(P, "weekday", { 60: 68, 120: 136, 240: 245 }),
  ...tiers(B, "weekend", { 60: 100, 120: 200 }),
  ...tiers(D, "weekend", { 60: 90 }),
];

const addons: AddonDef[] = [
  { id: "people", name: "Extra people", priceCents: 3000, studioId: null, maxQuantity: 1 },
  { id: "pet", name: "Pet fee", priceCents: 4000, studioId: D, maxQuantity: 1 },
];

const base = { rules, bundlePrices: [], multiStudioPercent: { 2: 20, 3: 22 }, addonCatalog: addons };

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof PricingError) return e.code;
    throw e;
  }
  return "NO_ERROR";
}

describe("quote", () => {
  it("uses the tier price, not hourly rate times hours", () => {
    const q = quote({ ...base, studioIds: [B], dayType: "weekday", durationMinutes: 240 });
    expect(q.totalCents).toBe(32000); // not 4 x $88 = $352
    expect(q.multiStudioDiscountCents).toBe(0);
  });

  it("prices weekends separately", () => {
    expect(quote({ ...base, studioIds: [B], dayType: "weekday", durationMinutes: 60 }).totalCents).toBe(8800);
    expect(quote({ ...base, studioIds: [B], dayType: "weekend", durationMinutes: 60 }).totalCents).toBe(10000);
  });

  it("discounts any combination of studios by how many are booked", () => {
    const two = quote({ ...base, studioIds: [B, D], dayType: "weekday", durationMinutes: 60 });
    expect(two.studiosSubtotalCents).toBe(16600);
    expect(two.multiStudioPercent).toBe(20);
    expect(two.multiStudioDiscountCents).toBe(3320);
    expect(two.totalCents).toBe(13280);

    const three = quote({ ...base, studioIds: [B, D, P], dayType: "weekday", durationMinutes: 60 });
    expect(three.multiStudioPercent).toBe(22);
    expect(three.totalCents).toBe(23400 - Math.round(23400 * 0.22));
  });

  it("applies no discount when none is configured", () => {
    const q = quote({ ...base, multiStudioPercent: {}, studioIds: [B, D], dayType: "weekday", durationMinutes: 60 });
    expect(q.totalCents).toBe(16600);
  });

  it("adds add-ons without discounting them", () => {
    const q = quote({
      ...base,
      studioIds: [B, D],
      dayType: "weekday",
      durationMinutes: 60,
      addons: [
        { addonId: "people", quantity: 1 },
        { addonId: "pet", quantity: 1 },
      ],
    });
    expect(q.addonsCents).toBe(7000);
    expect(q.totalCents).toBe(13280 + 7000);
  });

  it("refuses a studio-specific add-on when that studio is not booked", () => {
    expect(
      code(() =>
        quote({ ...base, studioIds: [B], dayType: "weekday", durationMinutes: 60, addons: [{ addonId: "pet", quantity: 1 }] }),
      ),
    ).toBe("ADDON_NOT_ALLOWED");
  });

  it("refuses bad add-on quantities and unknown add-ons", () => {
    const q = (addonId: string, quantity: number) =>
      code(() => quote({ ...base, studioIds: [D], dayType: "weekday", durationMinutes: 60, addons: [{ addonId, quantity }] }));
    expect(q("pet", 2)).toBe("BAD_QUANTITY");
    expect(q("pet", -1)).toBe("BAD_QUANTITY");
    expect(q("pet", 1.5)).toBe("BAD_QUANTITY");
    expect(q("nope", 1)).toBe("UNKNOWN_ADDON");
  });

  it("refuses durations that have no price, including negative and fractional ones", () => {
    const q = (durationMinutes: number) =>
      code(() => quote({ ...base, studioIds: [B], dayType: "weekday", durationMinutes }));
    expect(q(-60)).toBe("NO_PRICE");
    expect(q(6)).toBe("NO_PRICE");
    expect(q(0)).toBe("NO_PRICE");
    expect(q(150)).toBe("NO_PRICE");
    // Paris has no 10-hour price, so the pair cannot be booked for 10 hours.
    expect(code(() => quote({ ...base, studioIds: [B, P], dayType: "weekday", durationMinutes: 600 }))).toBe("NO_PRICE");
  });

  it("refuses empty and duplicate studio lists", () => {
    expect(code(() => quote({ ...base, studioIds: [], dayType: "weekday", durationMinutes: 60 }))).toBe("NO_STUDIOS");
    expect(code(() => quote({ ...base, studioIds: [B, B], dayType: "weekday", durationMinutes: 60 }))).toBe("DUPLICATE_STUDIO");
  });

  it("applies a percent code to the rental only", () => {
    const q = quote({
      ...base,
      studioIds: [D],
      dayType: "weekday",
      durationMinutes: 60,
      addons: [{ addonId: "pet", quantity: 1 }],
      promo: { kind: "percent", value: 10 },
    });
    expect(q.promoDiscountCents).toBe(780);
    expect(q.totalCents).toBe(7800 - 780 + 4000);
  });

  it("caps an amount code at the booking total and never goes negative", () => {
    const small = quote({ ...base, studioIds: [P], dayType: "weekday", durationMinutes: 60, promo: { kind: "amount", value: 2000 } });
    expect(small.totalCents).toBe(4800);
    const big = quote({ ...base, studioIds: [P], dayType: "weekday", durationMinutes: 60, promo: { kind: "amount", value: 50000 } });
    expect(big.promoDiscountCents).toBe(6800);
    expect(big.totalCents).toBe(0);
  });

  it("refuses nonsense codes", () => {
    const q = (promo: { kind: "percent" | "amount"; value: number }) =>
      code(() => quote({ ...base, studioIds: [P], dayType: "weekday", durationMinutes: 60, promo }));
    expect(q({ kind: "percent", value: 150 })).toBe("BAD_PROMO");
    expect(q({ kind: "percent", value: -10 })).toBe("BAD_PROMO");
    expect(q({ kind: "amount", value: -500 })).toBe("BAD_PROMO");
  });
});

describe("extra guests", () => {
  const blanche = { includedGuests: 6, extraGuests: 6 };
  const dayglow = { includedGuests: 6, extraGuests: 6 };
  const paris = { includedGuests: 4, extraGuests: 4 };
  const limits = { 2: 10, 3: 20 };

  it("are each studio's own number for one studio, and what the limit leaves above the included guests for several", () => {
    expect(extraGuestsAllowed([blanche], limits)).toBe(6);
    expect(extraGuestsAllowed([paris], limits)).toBe(4);
    expect(extraGuestsAllowed([paris, dayglow], limits)).toBe(0); // 4 + 6 included: the 10 are reached
    expect(extraGuestsAllowed([blanche, dayglow, paris], limits)).toBe(4); // 16 included, 20 at most
    expect(extraGuestsAllowed([paris, dayglow], { 2: 13, 3: 20 })).toBe(3);
    // Never more than the studios' own extra guests added together, nor below none.
    expect(extraGuestsAllowed([paris, dayglow], { 2: 100, 3: 20 })).toBe(10);
    expect(extraGuestsAllowed([blanche, dayglow], { 2: 8, 3: 20 })).toBe(0);
    expect(extraGuestsAllowed([], limits)).toBe(0);
  });

  it("are refused in the price beyond what the booking can take, counting every add-on for people", () => {
    const guest: AddonDef = { id: "guest", name: "Extra guest", priceCents: 500, studioId: null, maxQuantity: 20, kind: "people" };
    const base = { studioIds: [B], dayType: "weekday" as const, durationMinutes: 60, rules, bundlePrices: [], multiStudioPercent: {}, addonCatalog: [guest] };
    expect(quote({ ...base, addons: [{ addonId: "guest", quantity: 4 }], extraGuestsAllowed: 4 }).addonsCents).toBe(2000);
    expect(() => quote({ ...base, addons: [{ addonId: "guest", quantity: 5 }], extraGuestsAllowed: 4 })).toThrow("At most 4 extra guests can come with this booking.");
    expect(() => quote({ ...base, addons: [{ addonId: "guest", quantity: 1 }], extraGuestsAllowed: 0 })).toThrow("No extra guests can come with this booking.");
    expect(() => quote({ ...base, addons: [{ addonId: "guest", quantity: 2 }], extraGuestsAllowed: 1 })).toThrow("At most 1 extra guest can come with this booking.");
    // Left out, only the add-on's own most limits it.
    expect(quote({ ...base, addons: [{ addonId: "guest", quantity: 20 }] }).addonsCents).toBe(10000);
  });
});

describe("helpers", () => {
  it("offers only durations every selected studio has", () => {
    expect(bookableDurations([B], "weekday", rules, [])).toEqual([60, 120, 240, 600]);
    expect(bookableDurations([B, P], "weekday", rules, [])).toEqual([60, 120, 240]);
    expect(bookableDurations([B, D], "weekend", rules, [])).toEqual([60]);
    expect(bookableDurations([P], "weekend", rules, [])).toEqual([]);
    expect(bookableDurations([], "weekday", rules, [])).toEqual([]);
  });

  it("picks the discount rule for the largest count reached", () => {
    expect(multiStudioPercentFor(1, { 2: 20, 3: 22 })).toBe(0);
    expect(multiStudioPercentFor(2, { 2: 20, 3: 22 })).toBe(20);
    expect(multiStudioPercentFor(4, { 2: 20, 3: 22 })).toBe(22);
    expect(multiStudioPercentFor(3, { 2: 10 })).toBe(10);
    expect(multiStudioPercentFor(2, { 2: 500 })).toBe(0);
  });

  it("formats money", () => {
    expect(formatCents(8800)).toBe("$88");
    expect(formatCents(13280)).toBe("$132.80");
    expect(formatCents(150000)).toBe("$1,500");
    expect(formatCents(-780)).toBe("-$7.80");
  });
});

describe("a free hour", () => {
  const freeHour = { kind: "free_hour", value: 60 } as const;
  const one = { ...base, studioIds: [B], dayType: "weekday" as const, promo: freeHour };

  it("makes a one-hour booking of one studio free", () => {
    expect(quote({ ...one, durationMinutes: 60 })).toMatchObject({ promoDiscountCents: 8800, totalCents: 0, promoMisfit: null });
  });

  it("takes the one-hour price off a longer booking, so the customer pays for the rest", () => {
    expect(quote({ ...one, durationMinutes: 120 }).totalCents).toBe(17600 - 8800);
    // Four hours cost $320, less than four times the hourly price. One hour is still worth $88.
    expect(quote({ ...one, durationMinutes: 240 }).totalCents).toBe(32000 - 8800);
  });

  it("is worth the price of that kind of day", () => {
    expect(quote({ ...one, dayType: "weekend", durationMinutes: 120 }).totalCents).toBe(20000 - 10000);
  });

  it("is worth the same share of the booking when the studio is not sold by the hour", () => {
    const byTwoHours = tiers("loft", "weekday", { 120: 200, 180: 270 });
    const q = quote({ ...base, rules: byTwoHours, studioIds: ["loft"], dayType: "weekday", durationMinutes: 180, promo: freeHour });
    expect(q.promoDiscountCents).toBe(9000); // a third of three hours
  });

  it("never takes off more than the studio costs", () => {
    const withHalfHour = [...rules, ...tiers(B, "weekday", { 30: 50 })];
    const q = quote({ ...one, rules: withHalfHour, durationMinutes: 30 });
    expect(q).toMatchObject({ promoDiscountCents: 5000, totalCents: 0 });
  });

  it("pays for the studio, not for add-ons", () => {
    const q = quote({ ...base, studioIds: [D], dayType: "weekday", durationMinutes: 60, addons: [{ addonId: "pet", quantity: 1 }], promo: freeHour });
    expect(q).toMatchObject({ promoDiscountCents: 7800, addonsCents: 4000, totalCents: 4000 });
  });

  it("cannot be used when several studios are booked together: the price stays whole, with the reason", () => {
    const bundle = { ...base, studioIds: [B, P], dayType: "weekday" as const, durationMinutes: 60 };
    const q = quote({ ...bundle, promo: freeHour });
    expect(q).toMatchObject({ promoDiscountCents: 0, promoMisfit: "several_studios" });
    expect(q.totalCents).toBe(quote(bundle).totalCents);
  });

  it("is refused when it carries no time", () => {
    expect(code(() => quote({ ...one, durationMinutes: 60, promo: { kind: "free_hour", value: 0 } }))).toBe("BAD_PROMO");
  });
});

describe("membership minutes", () => {
  const member = (minutesLeft: number, weekendDifference = true) => ({ membership: { minutesLeft, weekendDifference } });

  it("pay the whole studio price when enough are left, never the add-ons", () => {
    const q = quote({ ...base, studioIds: [P], dayType: "weekday", durationMinutes: 120, addons: [{ addonId: "people", quantity: 1 }], ...member(300) });
    expect(q).toMatchObject({ membershipMinutes: 120, membershipCents: 13600, addonsCents: 3000, totalCents: 3000 });
  });

  it("pay their share of a longer booking, which pays the rest", () => {
    // 60 of 240 minutes: a quarter of $245 is covered, three quarters paid.
    const q = quote({ ...base, studioIds: [P], dayType: "weekday", durationMinutes: 240, ...member(60) });
    expect(q).toMatchObject({ membershipMinutes: 60, membershipCents: 6125, totalCents: 18375 });
    expect(quote({ ...base, studioIds: [P], dayType: "weekday", durationMinutes: 240, ...member(0) })).toMatchObject({ membershipMinutes: 0, membershipCents: 0, totalCents: 24500 });
  });

  it("cover studios booked together after their discount, as one booking's length", () => {
    // Blanche + Paris for 2 hours: $176 + $136, less 20%: $249.60. Two hours of minutes cover it all.
    const q = quote({ ...base, studioIds: [B, P], dayType: "weekday", durationMinutes: 120, ...member(300) });
    expect(q).toMatchObject({ membershipMinutes: 120, membershipCents: 24960, totalCents: 0 });
  });

  it("cover the weekday price at weekends while the owners keep that rule, and weekend time in full otherwise", () => {
    // Blanche for 2 hours on a Saturday: $200; on a weekday $176.
    expect(quote({ ...base, studioIds: [B], dayType: "weekend", durationMinutes: 120, ...member(300) })).toMatchObject({ membershipCents: 17600, totalCents: 2400 });
    expect(quote({ ...base, studioIds: [B], dayType: "weekend", durationMinutes: 120, ...member(300, false) })).toMatchObject({ membershipCents: 20000, totalCents: 0 });
    // Half of it covered: half the weekday price comes off the weekend price.
    expect(quote({ ...base, studioIds: [B], dayType: "weekend", durationMinutes: 120, ...member(60) })).toMatchObject({ membershipCents: 8800, totalCents: 11200 });
    // Dayglow's weekday hour is $78 and its weekend hour $90: the difference is paid.
    expect(quote({ ...base, studioIds: [D], dayType: "weekend", durationMinutes: 60, ...member(300) }).totalCents).toBe(9000 - 7800);
    // A length with a weekend price and no weekday one: the minutes cover the weekend price.
    const weekendOnly = [...rules, ...tiers(P, "weekend", { 90: 120 })];
    expect(quote({ ...base, rules: weekendOnly, studioIds: [P], dayType: "weekend", durationMinutes: 90, ...member(300) })).toMatchObject({ membershipCents: 12000, totalCents: 0 });
  });

  it("are not for a photography session, and refuse a balance that is not a whole number", () => {
    const session = quote({ ...base, studioIds: [P], dayType: "weekday", durationMinutes: 60, photoPackage: { priceCents: 25000 }, ...member(300) });
    expect(session).toMatchObject({ membershipMinutes: 0, membershipCents: 0, totalCents: 25000 });
    expect(code(() => quote({ ...base, studioIds: [P], dayType: "weekday", durationMinutes: 60, ...member(-1) }))).toBe("BAD_PROMO");
    expect(code(() => quote({ ...base, studioIds: [P], dayType: "weekday", durationMinutes: 60, ...member(1.5) }))).toBe("BAD_PROMO");
  });
});

describe("a code's booking days (question 80)", () => {
  const weekdaysOnly: PromoDef = { kind: "percent", value: 10, days: { from: null, until: null, weekdays: [1, 2, 3, 4, 5], notOnSpecialDates: true } };
  const one = { ...base, studioIds: [B], dayType: "weekday" as const, durationMinutes: 60, promo: weekdaysOnly };

  it("discounts a booking on one of its days, and none on another, saying why", () => {
    expect(quote({ ...one, bookingDay: { date: "2026-12-09", special: false } })).toMatchObject({ promoDiscountCents: 880, promoMisfit: null });
    expect(quote({ ...one, dayType: "weekend", bookingDay: { date: "2026-12-12", special: false } })).toMatchObject({ promoDiscountCents: 0, promoMisfit: "day" });
    expect(quote({ ...one, bookingDay: { date: "2026-12-10", special: true } })).toMatchObject({ promoDiscountCents: 0, promoMisfit: "day" });
    expect(promoMisfitText("day", weekdaysOnly, { date: "2026-12-12", special: false })).toBe(
      "That code works only for bookings on weekdays (Monday to Friday), not on holidays. December 12, 2026 is a Saturday. Choose another date, or book without the code.",
    );
  });

  it("is not checked before a day is chosen", () => {
    expect(quote({ ...one }).promoMisfit).toBeNull();
  });
});

describe("studios with prices together (the owner's brief of 2026-11-24, item 4; question 81)", () => {
  // Blanche and Paris have a list of their own; Dayglow and Paris have none.
  const bundlePrices: BundlePrice[] = [
    { studioIds: [B, P], durationMinutes: 60, priceCents: 14000 },
    { studioIds: [B, P], durationMinutes: 120, priceCents: 24500 },
    { studioIds: [B, P], durationMinutes: 360, priceCents: 64000 },
  ];
  const withList = { ...base, bundlePrices };

  it("cost what their list says, on a weekday and a weekend alike, with nothing more off for booking several", () => {
    const weekday = quote({ ...withList, studioIds: [P, B], dayType: "weekday", durationMinutes: 60 });
    expect(weekday).toMatchObject({ studiosSubtotalCents: 14000, multiStudioPercent: 0, multiStudioDiscountCents: 0, totalCents: 14000 });
    // Each studio's part, as their own prices share it ($68 and $88), in the order asked, to the cent.
    expect(weekday.studioLines).toEqual([
      { studioId: P, priceCents: 6103 },
      { studioId: B, priceCents: 7897 },
    ]);
    // Paris has no weekend price of its own: the bundle's price does not ask for one, and is shared evenly.
    const weekend = quote({ ...withList, studioIds: [B, P], dayType: "weekend", durationMinutes: 60 });
    expect(weekend).toMatchObject({ totalCents: 14000, studioLines: [{ studioId: B, priceCents: 7000 }, { studioId: P, priceCents: 7000 }] });
  });

  it("are sold for the lengths of their list only, whatever the studios cost alone", () => {
    // Six hours: neither studio has a price of its own for it.
    expect(quote({ ...withList, studioIds: [B, P], dayType: "weekday", durationMinutes: 360 }).totalCents).toBe(64000);
    // Four hours: both studios have one, the list has not.
    expect(code(() => quote({ ...withList, studioIds: [B, P], dayType: "weekday", durationMinutes: 240 }))).toBe("NO_PRICE");
    expect(bookableDurations([B, P], "weekday", rules, bundlePrices)).toEqual([60, 120, 360]);
    expect(bookableDurations([P, B], "weekend", rules, bundlePrices)).toEqual([60, 120, 360]);
    expect(unpriced([B, P], "weekday", 360, rules, bundlePrices)).toBeNull();
    expect(unpriced([B, P], "weekday", 240, rules, bundlePrices)).toEqual({ studioIds: [B, P], together: true });
  });

  it("leave other studios, and one studio, to their own prices and the discount by number", () => {
    expect(quote({ ...withList, studioIds: [D, P], dayType: "weekday", durationMinutes: 60 })).toMatchObject({ studiosSubtotalCents: 14600, multiStudioPercent: 20, totalCents: 11680 });
    expect(quote({ ...withList, studioIds: [B, D, P], dayType: "weekday", durationMinutes: 60 }).multiStudioPercent).toBe(22);
    expect(quote({ ...withList, studioIds: [B], dayType: "weekday", durationMinutes: 240 }).totalCents).toBe(32000);
    expect(bundleList([B], bundlePrices)).toEqual([]);
    expect(bundleList([B, D, P], bundlePrices)).toEqual([]);
    expect(unpriced([D, P], "weekend", 60, rules, bundlePrices)).toEqual({ studioIds: [P], together: false });
    expect(unpriced([B], "weekday", 60, rules, bundlePrices)).toBeNull();
  });

  it("take a code's percentage and add-ons as any booking does", () => {
    const q = quote({ ...withList, studioIds: [B, P], dayType: "weekday", durationMinutes: 120, addons: [{ addonId: "people", quantity: 1 }], promo: { kind: "percent", value: 10 } });
    expect(q).toMatchObject({ studiosSubtotalCents: 24500, promoDiscountCents: 2450, addonsCents: 3000, totalCents: 24500 - 2450 + 3000 });
  });

  it("are paid by membership minutes at the same price at weekends, with no weekday price to differ from", () => {
    const member = { membership: { minutesLeft: 600, weekendDifference: true } };
    expect(quote({ ...withList, studioIds: [B, P], dayType: "weekend", durationMinutes: 120, ...member })).toMatchObject({ membershipMinutes: 120, membershipCents: 24500, totalCents: 0 });
    expect(quote({ ...withList, studioIds: [B, P], dayType: "weekday", durationMinutes: 120, membership: { minutesLeft: 60, weekendDifference: false } })).toMatchObject({ membershipCents: 12250, totalCents: 12250 });
  });

  it("are one line of a summary, and studios with a discount for several a line each", () => {
    const studios = [
      { name: "Studio Blanche", priceCents: 7897 },
      { name: "Studio Paris", priceCents: 6103 },
    ];
    expect(studioPriceLines(studios, 0)).toEqual([{ name: "Studio Blanche + Studio Paris", priceCents: 14000 }]);
    expect(studioPriceLines(studios, 2800)).toEqual(studios);
    expect(studioPriceLines([studios[0]], 0)).toEqual([studios[0]]);
  });

  it("are named by their studios' ids in one order, however they were chosen", () => {
    expect(bundleKey(["b", "a", "c"])).toBe("a+b+c");
    expect(bundleKey(["c", "a", "b"])).toBe(bundleKey(["a", "b", "c"]));
  });
});

describe("the lengths between the listed ones (question 83)", () => {
  const list = [
    { durationMinutes: 300, priceCents: 49000 },
    { durationMinutes: 120, priceCents: 23000 },
    { durationMinutes: 180, priceCents: 32000 },
    { durationMinutes: 60, priceCents: 11500 },
    { durationMinutes: 90, priceCents: 17200 },
  ];

  it("are priced on the line between their two neighbours, to a whole dollar", () => {
    expect(betweenLengths(list, 30)).toEqual([
      { durationMinutes: 150, priceCents: 27500 }, // halfway between $230 and $320
      { durationMinutes: 210, priceCents: 36300 }, // a quarter of the way from $320 to $490: $362.50, to a whole dollar
      { durationMinutes: 240, priceCents: 40500 },
      { durationMinutes: 270, priceCents: 44800 }, // $447.50
    ]);
  });

  it("are every whole hour when the owners sell those, and none when they sell only the listed lengths", () => {
    expect(betweenLengths(list, 60).map((row) => row.durationMinutes)).toEqual([240]);
    expect(betweenLengths(list, 0)).toEqual([]);
    expect(betweenLengths(list, -30)).toEqual([]);
    expect(betweenLengths(list, 7.5)).toEqual([]);
  });

  it("never reach below the shortest listed length or above the longest", () => {
    const made = betweenLengths([{ durationMinutes: 300, priceCents: 80000 }, { durationMinutes: 600, priceCents: 150000 }], 30);
    expect(made[0]).toEqual({ durationMinutes: 330, priceCents: 87000 });
    expect(made.at(-1)).toEqual({ durationMinutes: 570, priceCents: 143000 });
    expect(made).toHaveLength(9);
    expect(betweenLengths([{ durationMinutes: 60, priceCents: 100 }], 30)).toEqual([]);
  });

  it("are added to each studio's prices by kind of day, and to each bundle's list, and marked", () => {
    const made = rulesWithBetween(rules, 60);
    // Blanche on weekdays has 1, 2, 4 and 10 hours: 3 hours between 2 and 4, and 5 to 9 between 4 and 10.
    expect(made.filter((rule) => rule.studioId === B && rule.dayType === "weekday" && rule.between).map((rule) => [rule.durationMinutes, rule.priceCents])).toEqual([
      [180, 24800],
      [300, 38700],
      [360, 45300],
      [420, 52000],
      [480, 58700],
      [540, 65300],
    ]);
    // Blanche at weekends has 1 and 2 hours, with nothing between at whole hours; Dayglow has one length.
    expect(made.filter((rule) => rule.dayType === "weekend" && rule.between)).toEqual([]);
    expect(made.filter((rule) => !rule.between)).toEqual(rules);
    expect(findPrice(B, "weekday", 180, made)).toBe(24800);

    const bundles: BundlePrice[] = [
      { studioIds: [B, P], durationMinutes: 60, priceCents: 14000 },
      { studioIds: [P, B], durationMinutes: 120, priceCents: 24500 },
      { studioIds: [D, P], durationMinutes: 60, priceCents: 11500 },
    ];
    expect(bundlePricesWithBetween(bundles, 30)).toEqual([...bundles, { studioIds: [B, P], durationMinutes: 90, priceCents: 19300, between: true }]);
    // A length between is sold like a listed one.
    expect(quote({ ...base, bundlePrices: bundlePricesWithBetween(bundles, 30), studioIds: [B, P], dayType: "weekday", durationMinutes: 90 }).totalCents).toBe(19300);
  });
});
