import { describe, expect, it } from "vitest";
import { monthLabel, monthWeeks, rangeOf, shiftDate, shortDayLabel, weekDays, weekLabel, weekStart } from "./calendar";

describe("the calendar's weeks", () => {
  it("run from Sunday to Saturday", () => {
    expect(weekStart("2026-11-18")).toBe("2026-11-15"); // a Wednesday
    expect(weekStart("2026-11-15")).toBe("2026-11-15"); // a Sunday is its own start
    expect(weekStart("2026-11-21")).toBe("2026-11-15"); // a Saturday
    expect(weekDays("2026-11-18")).toEqual([
      "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21",
    ]);
  });

  it("cross a month and a year without losing a day", () => {
    expect(weekDays("2026-12-31")).toEqual([
      "2026-12-27", "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02",
    ]);
  });
});

describe("the month view", () => {
  it("shows whole weeks that cover the month", () => {
    const weeks = monthWeeks("2026-11-18");
    expect(weeks).toHaveLength(5);
    expect(weeks[0][0]).toBe("2026-11-01"); // November 2026 begins on a Sunday
    expect(weeks[4][6]).toBe("2026-12-05");
    expect(weeks.flat().filter((day) => day.startsWith("2026-11"))).toHaveLength(30);
  });

  it("needs six weeks for some months and four for others", () => {
    expect(monthWeeks("2026-08-10")).toHaveLength(6); // begins on a Saturday
    expect(monthWeeks("2026-02-10")).toHaveLength(4); // 28 days from a Sunday
    expect(monthWeeks("2026-08-10")[0][0]).toBe("2026-07-26");
  });
});

describe("what a view shows and where the arrows lead", () => {
  it("covers a day, a week, or the weeks of a month; the end is the day after the last", () => {
    expect(rangeOf("day", "2026-11-18")).toEqual({ from: "2026-11-18", to: "2026-11-19" });
    expect(rangeOf("week", "2026-11-18")).toEqual({ from: "2026-11-15", to: "2026-11-22" });
    expect(rangeOf("month", "2026-11-18")).toEqual({ from: "2026-11-01", to: "2026-12-06" });
  });

  it("moves by a day, a week or a month", () => {
    expect(shiftDate("day", "2026-11-30", 1)).toBe("2026-12-01");
    expect(shiftDate("week", "2026-11-18", -1)).toBe("2026-11-11");
    expect(shiftDate("month", "2026-11-18", 1)).toBe("2026-12-01");
    expect(shiftDate("month", "2026-01-31", 1)).toBe("2026-02-01"); // never skips the short month
    expect(shiftDate("month", "2026-01-15", -1)).toBe("2025-12-01");
  });

  it("names what is on screen", () => {
    expect(monthLabel("2026-11-18")).toBe("November 2026");
    expect(shortDayLabel("2026-11-18")).toBe("Wed 18");
    expect(shortDayLabel("2026-11-15")).toBe("Sun 15");
    expect(weekLabel("2026-11-18")).toBe("Nov 15 – 21, 2026");
    expect(weekLabel("2026-12-01")).toBe("Nov 29 – Dec 5, 2026");
  });
});
