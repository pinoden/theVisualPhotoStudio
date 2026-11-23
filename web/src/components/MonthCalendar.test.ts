import { describe, expect, it } from "vitest";
import { monthTitle, shiftMonth, weeksOf } from "./MonthCalendar";

describe("the booking page's month calendar", () => {
  it("moves a month at a time, across the year", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2027-01", -1)).toBe("2026-12");
    expect(shiftMonth("2026-11", 0)).toBe("2026-11");
    expect(monthTitle("2026-12")).toBe("December 2026");
  });

  it("lays a month out in weeks that start on Sunday", () => {
    // November 1, 2026 is a Sunday; February 1, 2028 a Tuesday, in a leap year.
    const november = weeksOf("2026-11");
    expect(november[0][0]).toBe("2026-11-01");
    expect(november.flat().filter(Boolean)).toHaveLength(30);
    const february = weeksOf("2028-02");
    expect(february[0].slice(0, 3)).toEqual([null, null, "2028-02-01"]);
    expect(february.flat().filter(Boolean)).toHaveLength(29);
    expect(february.every((week) => week.length === 7)).toBe(true);
  });
});
