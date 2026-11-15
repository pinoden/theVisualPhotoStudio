import { describe, expect, it } from "vitest";
import { count, hoursInWords, listInWords } from "./words";

describe("sentences with a number the owner can change", () => {
  it("uses the singular for one", () => {
    expect(count(1, "day")).toBe("1 day");
    expect(count(0, "day")).toBe("0 days");
    expect(count(90, "day")).toBe("90 days");
  });

  it("says whole days from two up as days, and everything else in hours", () => {
    expect(hoursInWords(168)).toBe("7 days");
    expect(hoursInWords(48)).toBe("2 days");
    expect(hoursInWords(24)).toBe("24 hours");
    expect(hoursInWords(100)).toBe("100 hours");
    expect(hoursInWords(1)).toBe("1 hour");
  });

  it("lists names with one 'and'", () => {
    expect(listInWords([])).toBe("");
    expect(listInWords(["Studio Blanche"])).toBe("Studio Blanche");
    expect(listInWords(["Studio Blanche", "Studio Paris"])).toBe("Studio Blanche and Studio Paris");
    expect(listInWords(["Studio Blanche", "Studio Paris", "all common areas"])).toBe(
      "Studio Blanche, Studio Paris and all common areas",
    );
  });
});
