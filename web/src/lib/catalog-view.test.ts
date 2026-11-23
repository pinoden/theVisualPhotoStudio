import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/server/settings";
import { multiStudioOffer, multiStudioSaving } from "./catalog-view";
import { multiStudioPercentFor } from "./domain/pricing";

const offer = (table: Record<number, number>) =>
  multiStudioOffer({ settings: { ...DEFAULT_SETTINGS, multiStudioPercent: table } });

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
    multiStudioSaving({ settings: { ...DEFAULT_SETTINGS, multiStudioPercent: table }, studios: studios(n) });

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
    expect(multiStudioSaving({ settings: DEFAULT_SETTINGS, studios: studios(3) })).toBe(
      "Save 20% when booking two studios and 22% when booking three studios",
    );
  });
});
