import { describe, expect, it } from "vitest";
import {
  bookableDurations,
  formatCents,
  multiStudioPercentFor,
  PricingError,
  quote,
  type AddonDef,
  type PriceRule,
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

const base = { rules, multiStudioPercent: { 2: 20, 3: 22 }, addonCatalog: addons };

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

describe("helpers", () => {
  it("offers only durations every selected studio has", () => {
    expect(bookableDurations([B], "weekday", rules)).toEqual([60, 120, 240, 600]);
    expect(bookableDurations([B, P], "weekday", rules)).toEqual([60, 120, 240]);
    expect(bookableDurations([B, D], "weekend", rules)).toEqual([60]);
    expect(bookableDurations([P], "weekend", rules)).toEqual([]);
    expect(bookableDurations([], "weekday", rules)).toEqual([]);
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
