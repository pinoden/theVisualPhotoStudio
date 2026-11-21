import { describe, expect, it } from "vitest";
import { z } from "zod";
import { normalizeEmail } from "@/server/auth";
import { CHARGE_MAX_CENTS } from "@/server/charges";
import { normalizeCode } from "@/server/promos";
import { MONEY_SETTING_RANGES } from "@/server/settings";
import {
  centsToInput,
  dollarsToCents,
  CHARGE_PATTERN,
  DOLLARS_PATTERN,
  FEE_PATTERN,
  EMAIL_PATTERN,
  EMAIL_RULE,
  formText,
  hhmmToMinutes,
  intInRange,
  POSITIVE_DOLLARS_PATTERN,
  PRICE_PATTERN,
  PROMO_CODE_FIELD,
  PROMO_CODE_RULE,
} from "./parse";

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

  it("takes a comma only between thousands, so a decimal comma is never read as a hundred times more", () => {
    expect(dollarsToCents("1,250")).toBe(125000);
    expect(dollarsToCents("1,250.5")).toBe(125050);
    expect(dollarsToCents("9,999,999.99")).toBe(999999999);
    for (const bad of ["12,50", "40,50", "1,5", "1,2345", ",500", "1,250,", "12,345,678", "1.250,00", "45 dollars"]) {
      expect(dollarsToCents(bad)).toBeNull();
    }
  });

  it("gives the browser the same rule for its own check of a money field", () => {
    const field = new RegExp(`^(?:${DOLLARS_PATTERN})$`, "v"); // how a browser applies a pattern attribute
    for (const text of ["40", "40.50", "$1,500.00", " 88 ", "12,50", "45 dollars", "1,5", ""]) {
      expect(field.test(text)).toBe(dollarsToCents(text) !== null);
    }
  });

  it("formats cents back for an input", () => {
    expect(centsToInput(8800)).toBe("88");
    expect(centsToInput(8850)).toBe("88.50");
    expect(centsToInput(7)).toBe("0.07");
    expect(dollarsToCents(centsToInput(13280))).toBe(13280);
  });
});

describe("text typed into a form", () => {
  it("counts a line break once, as the field's own limit does", () => {
    expect(formText("one\r\ntwo\rthree\nfour")).toBe("one\ntwo\nthree\nfour");
    expect(formText("x".repeat(10) + "\r\n".repeat(5) + "y")).toHaveLength(16);
  });

  it("trims, drops the one character the database cannot store, and turns anything else into nothing", () => {
    expect(formText("  Jane\u0000 Smith \n")).toBe("Jane Smith");
    expect(formText(null)).toBe("");
    expect(formText(new Blob(["x"]))).toBe("");
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
    for (const bad of ["101", "-1", "5.5", "five", "", null, 5, "0x10", "1e3"]) expect(intInRange(bad, 0, 100)).toBeNull();
    // What a number field sends for a whole number, written another way.
    expect(intInRange("5.0", 0, 100)).toBe(5);
    expect(intInRange("1e3", 0, 1000)).toBe(1000);
    expect(intInRange("240e-1", 0, 100)).toBe(24);
    expect(intInRange("245e-1", 0, 100)).toBeNull();
    // A number field lets these through as 50 too.
    expect(intInRange(".5e2", 0, 100)).toBe(50);
    expect(intInRange("0000000050", 0, 100)).toBe(50);
    expect(intInRange("1e400", 0, 100)).toBeNull();
    expect(intInRange(`${"0".repeat(41)}50`, 0, 100)).toBe(50);
    expect(intInRange("5.", 0, 100)).toBe(5);
  });
});

describe("an email address typed into a form", () => {
  // The booking's own check, the sign-in check, and the pattern a field gives the browser, read as a browser reads it.
  const booking = (text: string) => z.string().trim().toLowerCase().max(200).pipe(z.email()).safeParse(text).success;
  const field = (text: string) => new RegExp(`^(?:${EMAIL_PATTERN})$`, "v").test(text);
  const addresses = [
    "jane@example.com",
    "Jane.Smith+studio@example.co.uk",
    "o'brien@example.ie",
    "a_b-c@sub-domain.example.com",
    "x@y.io",
    // What the browser let through before and the server refused (the tester's, 2026-11-16).
    "jane..smith@example.com",
    "jane.@example.com",
    "jo!e@example.com",
    "jane@example.c0",
    "jane@example.123",
    ".jane@example.com",
    "jane@-example.com",
    "jane@example",
    "@example.com",
    "jane @example.com",
  ];

  it("is taken or refused alike by the browser, the booking and the sign-in", () => {
    for (const address of addresses) {
      const taken = booking(address);
      expect(field(address), address).toBe(taken);
      expect(EMAIL_RULE.test(address), address).toBe(taken);
      expect(normalizeEmail(address) !== null, address).toBe(taken);
    }
    expect(addresses.filter(booking)).toEqual(["jane@example.com", "Jane.Smith+studio@example.co.uk", "o'brien@example.ie", "a_b-c@sub-domain.example.com", "x@y.io"]);
  });
});

describe("a code an owner names", () => {
  // The pattern the field gives the browser, read as a browser reads it, and the server's rule once the code is in
  // capitals. Spaces are left out: the server drops them, while the browser refuses them.
  const field = (text: string) => new RegExp(`^(?:${PROMO_CODE_FIELD.pattern})$`, "v").test(text);
  const server = (text: string) => PROMO_CODE_RULE.test(normalizeCode(text));
  const codes = ["SPRING-20", "spring-20", "VIP", "A1B", "x".repeat(30), "AB", "x".repeat(31), "-SPRING", "SPRING-", "SPRING_20", "SPRÍNG", "20%OFF"];

  it("is taken or refused alike by the browser and the server", () => {
    for (const code of codes) expect(field(code), code).toBe(server(code));
    expect(codes.filter(server)).toEqual(["SPRING-20", "spring-20", "VIP", "A1B", "x".repeat(30)]);
  });
});

describe("the patterns a browser checks a money field with", () => {
  // As a browser reads a field's pattern: whole, and with the "v" flag.
  const accepts = (pattern: string, text: string) => new RegExp(`^(?:${pattern})$`, "v").test(text);

  it("take a price up to $100,000 and nothing above", () => {
    for (const ok of ["0", "88", "88.50", "$1,500", "99,999.99", "100000", "100,000.00"]) expect(accepts(PRICE_PATTERN, ok), ok).toBe(true);
    for (const bad of ["100000.01", "150000", "1,000,000", "12,50", "-5"]) expect(accepts(PRICE_PATTERN, bad), bad).toBe(false);
  });

  it("take a fee in Settings up to $1,000, the server's limit, and nothing above", () => {
    expect(MONEY_SETTING_RANGES.rescheduleFeeCents).toEqual([0, 100_000]);
    for (const ok of ["0", "20", "20.5", "$35.50", "999.99", "1000", "$1,000.00", "  25  "]) expect(accepts(FEE_PATTERN, ok), ok).toBe(true);
    for (const bad of ["1000.01", "1500", "1,500", "9999999", "-5", "20.555", "abc", ""]) expect(accepts(FEE_PATTERN, bad), bad).toBe(false);
    for (const ok of ["0", "20.5", "999.99", "1000", "$1,000.00"]) expect(dollarsToCents(ok), ok).not.toBeNull();
  });

  it("take an extra charge up to $10,000, the server's limit, and nothing above", () => {
    expect(CHARGE_MAX_CENTS).toBe(1_000_000);
    for (const ok of ["50", "50.5", "$1,250.00", "9999.99", "10000", "$10,000.00"]) expect(accepts(CHARGE_PATTERN, ok), ok).toBe(true);
    for (const bad of ["10000.01", "12000", "10,001", "-5", "abc", "1.234"]) expect(accepts(CHARGE_PATTERN, bad), bad).toBe(false);
  });

  it("take a credit above zero only", () => {
    for (const ok of ["40", "0.50", "$1,250.00"]) expect(accepts(POSITIVE_DOLLARS_PATTERN, ok), ok).toBe(true);
    for (const bad of ["0", "0.00", "$0", " 0 ", "00"]) expect(accepts(POSITIVE_DOLLARS_PATTERN, bad), bad).toBe(false);
  });
});
