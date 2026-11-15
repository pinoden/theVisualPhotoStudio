import { describe, expect, it } from "vitest";
import { centsToInput, dollarsToCents, hhmmToMinutes, intInRange } from "./parse";

describe("money typed into a form", () => {
  it("reads whole and decimal amounts exactly", () => {
    expect(dollarsToCents("88")).toBe(8800);
    expect(dollarsToCents("88.5")).toBe(8850);
    expect(dollarsToCents("88.50")).toBe(8850);
    expect(dollarsToCents("0.07")).toBe(7);
    expect(dollarsToCents("0.29")).toBe(29); // 0.29 * 100 is 28.999... in floating point
    expect(dollarsToCents(" $1,500.00 ")).toBe(150000);
    expect(dollarsToCents("0")).toBe(0);
  });

  it("refuses anything else", () => {
    for (const bad of ["", "abc", "-5", "88.555", "1e3", "88.", ".50", "12 34", "99999999", null, 88]) {
      expect(dollarsToCents(bad)).toBeNull();
    }
  });

  it("formats cents back for an input", () => {
    expect(centsToInput(8800)).toBe("88");
    expect(centsToInput(8850)).toBe("88.50");
    expect(centsToInput(7)).toBe("0.07");
    expect(dollarsToCents(centsToInput(13280))).toBe(13280);
  });
});

describe("times and numbers typed into a form", () => {
  it("reads clock times", () => {
    expect(hhmmToMinutes("09:30")).toBe(570);
    expect(hhmmToMinutes("9:00")).toBe(540);
    expect(hhmmToMinutes("00:00")).toBe(0);
    expect(hhmmToMinutes("24:00")).toBe(1440);
    for (const bad of ["24:01", "25:00", "12:60", "noon", "", "12", null]) expect(hhmmToMinutes(bad)).toBeNull();
  });

  it("reads whole numbers within a range", () => {
    expect(intInRange("5", 0, 100)).toBe(5);
    expect(intInRange(" 100 ", 0, 100)).toBe(100);
    for (const bad of ["101", "-1", "5.5", "five", "", null, 5]) expect(intInRange(bad, 0, 100)).toBeNull();
  });
});
