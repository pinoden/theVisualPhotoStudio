import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/server/settings";
import { multiStudioOffer } from "./catalog-view";
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
