import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/server/settings";
import { bookingLengths, bundleName, bundleOffer, bundleTables, multiStudioOffer, multiStudioSaving, priceTable, shownLengths } from "./catalog-view";
import { multiStudioPercentFor } from "./domain/pricing";

const offer = (table: Record<number, number>) =>
  multiStudioOffer({ settings: { ...DEFAULT_SETTINGS, multiStudioPercent: table }, bundlePrices: [] });

describe("the sentence about booking several studios", () => {
  it("names each discount, and says 'or more' for the last one", () => {
    expect(offer({ 2: 20, 3: 22 })).toBe("20% off when you book 2, 22% off when you book 3 or more");
    expect(offer({ 2: 20, 3: 20 })).toBe("20% off when you book 2 or more");
    expect(offer({ 2: 0, 3: 22 })).toBe("22% off when you book 3 or more");
    expect(offer({ 2: 10 })).toBe("10% off when you book 2 or more");
  });

  it("never promises three studios a discount that only two get", () => {
    expect(offer({ 2: 15, 3: 0 })).toBe("15% off when you book exactly 2");
    expect(multiStudioPercentFor(3, { 2: 15, 3: 0 })).toBe(0); // what is charged
  });

  it("is empty when there is no discount", () => {
    expect(offer({})).toBe("");
    expect(offer({ 2: 0, 3: 0 })).toBe("");
  });

  it("agrees with the price calculation for every number of studios", () => {
    const tables: Record<number, number>[] = [{ 2: 20, 3: 22 }, { 2: 15, 3: 0 }, { 2: 0, 3: 30 }, { 2: 5, 3: 5, 4: 0, 5: 40 }];
    for (const table of tables) {
      const text = offer(table);
      for (let studios = 2; studios <= 7; studios++) {
        const percent = multiStudioPercentFor(studios, table);
        // A number of studios that gets a discount is covered by a phrase with that percentage.
        const covered = text.split(", ").some((phrase) => {
          const match = /^(\d+)% off when you book (exactly )?(\d+)(?: to (\d+))?( or more)?$/.exec(phrase)!;
          const from = Number(match[3]);
          const to = match[5] ? Infinity : Number(match[4] ?? match[3]);
          return Number(match[1]) === percent && studios >= from && studios <= to;
        });
        expect(covered, `${JSON.stringify(table)} with ${studios} studios`).toBe(percent > 0);
      }
    }
  });
});

describe("the booking page's sentence about several studios (the owner's words of 2026-11-22)", () => {
  const studios = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}` })) as never;
  const saving = (table: Record<number, number>, n = 3) =>
    multiStudioSaving({ settings: { ...DEFAULT_SETTINGS, multiStudioPercent: table }, studios: studios(n), bundlePrices: [] });

  it("says the numbers of studios in words, up to the studios the site has", () => {
    expect(saving({ 2: 20, 3: 22 })).toBe("Save 20% when booking two studios and 22% when booking three studios");
    expect(saving({ 2: 20, 3: 20 })).toBe("Save 20% when booking two or three studios");
    expect(saving({ 2: 0, 3: 22 })).toBe("Save 22% when booking three studios");
    expect(saving({ 2: 20, 3: 22 }, 4)).toBe("Save 20% when booking two studios and 22% when booking three or four studios");
    expect(saving({ 2: 10, 3: 15, 4: 20 }, 5)).toBe(
      "Save 10% when booking two studios, 15% when booking three studios and 20% when booking four or five studios",
    );
  });

  it("promises no more than is charged, and says nothing when nothing is saved", () => {
    expect(saving({ 2: 15, 3: 0 })).toBe("Save 15% when booking two studios");
    expect(saving({})).toBe("");
    expect(saving({ 2: 20, 3: 22 }, 1)).toBe("");
  });

  it("follows the default discount", () => {
    expect(multiStudioSaving({ settings: DEFAULT_SETTINGS, studios: studios(3), bundlePrices: [] })).toBe(
      "Save 20% when booking two studios and 22% when booking three studios",
    );
  });
});

describe("the bundles with prices of their own (question 81)", () => {
  const studios = [
    { id: "b", slug: "blanche", name: "Studio Blanche", color: "#111111" },
    { id: "d", slug: "dayglow", name: "Studio Dayglow", color: "#222222" },
    { id: "p", slug: "paris", name: "Studio Paris", color: "#333333" },
  ] as never;
  const price = (studioIds: string[], durationMinutes: number, dollars: number, between?: true) => ({ studioIds, durationMinutes, priceCents: dollars * 100, ...(between ? { between } : {}) });
  const bundlePrices = [
    price(["b", "d", "p"], 600, 1500),
    price(["b", "d", "p"], 60, 180),
    price(["b", "p"], 120, 245),
    price(["b", "p"], 60, 140),
    price(["b", "p"], 90, 193, true),
    price(["d", "p"], 60, 115),
  ];
  const catalog = { studios, bundlePrices, settings: DEFAULT_SETTINGS };

  it("are named in the owner's words, and all the studios together in words", () => {
    expect(bundleName(catalog, ["d", "p"])).toBe("Paris + Dayglow");
    expect(bundleName(catalog, ["b", "p"])).toBe("Paris + Blanche");
    expect(bundleName(catalog, ["b", "d"])).toBe("Blanche + Dayglow"); // not one the owner named: its studios, in order
    expect(bundleName(catalog, ["b", "d", "p"])).toBe("All three studios");
    expect(bundleName(catalog, ["p"])).toBe("Studio Paris");
  });

  it("are listed the fewest studios first, then the cheapest, with the listed lengths only, shortest first", () => {
    expect(bundleTables(catalog)).toEqual([
      { studioIds: ["d", "p"], name: "Paris + Dayglow", prices: [{ durationMinutes: 60, priceCents: 11500 }] },
      { studioIds: ["b", "p"], name: "Paris + Blanche", prices: [{ durationMinutes: 60, priceCents: 14000 }, { durationMinutes: 120, priceCents: 24500 }] },
      { studioIds: ["b", "d", "p"], name: "All three studios", prices: [{ durationMinutes: 60, priceCents: 18000 }, { durationMinutes: 600, priceCents: 150000 }] },
    ]);
  });

  it("are what the booking page says in place of a percentage, which no page promises any more", () => {
    expect(bundleOffer(catalog)).toBe("Bundle prices: Paris + Dayglow from $115, Paris + Blanche from $140, all three studios from $180");
    expect(multiStudioSaving(catalog)).toBe("");
    expect(multiStudioOffer(catalog)).toBe("");
    expect(bundleOffer({ studios, bundlePrices: [] })).toBe("");
  });

  it("leave the lengths between out of a studio's price list too", () => {
    const rules = [
      { studioId: "p", dayType: "weekday" as const, durationMinutes: 60, priceCents: 6800 },
      { studioId: "p", dayType: "weekday" as const, durationMinutes: 90, priceCents: 10200, between: true as const },
      { studioId: "p", dayType: "weekend" as const, durationMinutes: 60, priceCents: 7200 },
    ];
    expect(priceTable({ rules }, "p")).toEqual([{ durationMinutes: 60, weekdayCents: 6800, weekendCents: 7200 }]);
  });
});

describe("the lengths the booking screen shows (the owner, 2026-11-25: \"1, 2, 3, 4, 6 more\")", () => {
  const halfHours = Array.from({ length: 19 }, (_, i) => 60 + i * 30);
  const first = DEFAULT_SETTINGS.shownLengthsMinutes;

  it("shows the owners' first lengths, and the rest behind More, each shortest first", () => {
    expect(first).toEqual([60, 120, 180, 240, 360]);
    const { shown, more } = shownLengths([...halfHours].reverse(), first);
    expect(shown).toEqual([60, 120, 180, 240, 360]);
    expect(more.slice(0, 5)).toEqual([90, 150, 210, 270, 300]); // five hours among them
    expect(more.at(-1)).toBe(600);
    expect(shown.length + more.length).toBe(19);
  });

  it("shows those of them the selection offers, its own when it offers none, and nothing behind More when all are shown", () => {
    expect(shownLengths([60, 90, 120, 300, 330, 600], first)).toEqual({ shown: [60, 120], more: [90, 300, 330, 600] });
    expect(shownLengths([60, 120, 600], first)).toEqual({ shown: [60, 120, 600], more: [] }); // no more than five: all shown
    // Paris + Dayglow with only its listed lengths: 1.5 and 5 hours behind More.
    expect(shownLengths([60, 90, 120, 180, 240, 300, 360], first)).toEqual({ shown: [60, 120, 180, 240, 360], more: [90, 300] });
    expect(shownLengths([90, 150, 300, 420, 450, 480, 510], first)).toEqual({ shown: [90, 150, 300, 420, 480], more: [450, 510] });
    expect(shownLengths([], first)).toEqual({ shown: [], more: [] });
  });

  it("names the range every studio and bundle can be booked for", () => {
    const row = (durationMinutes: number) => ({ studioId: "s", dayType: "weekday" as const, durationMinutes, priceCents: 100 });
    expect(bookingLengths({ rules: halfHours.map(row), bundlePrices: [] })).toBe("1 to 10 hours");
    expect(bookingLengths({ rules: [row(90), row(300)], bundlePrices: [] })).toBe("1.5 to 5 hours");
    expect(bookingLengths({ rules: [row(30), row(120)], bundlePrices: [] })).toBe("30 minutes to 2 hours");
    expect(bookingLengths({ rules: [row(60)], bundlePrices: [] })).toBe("1 hour");
    expect(bookingLengths({ rules: [], bundlePrices: [] })).toBe("");
  });
});
