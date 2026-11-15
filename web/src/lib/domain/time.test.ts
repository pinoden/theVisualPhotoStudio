import { describe, expect, it } from "vitest";
import {
  addDays,
  daysBetween,
  defaultDayType,
  durationLabel,
  isIsoDate,
  isoWeekday,
  longDateLabel,
  minutesToHHMM,
  minutesToLabel,
} from "./time";

describe("dates", () => {
  it("accepts real dates and rejects impossible ones", () => {
    expect(isIsoDate("2026-11-21")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("21/11/2026")).toBe(false);
    expect(isIsoDate("2026-11-21T10:00")).toBe(false);
  });

  it("knows weekdays and weekends", () => {
    expect(isoWeekday("2026-11-16")).toBe(1); // Monday
    expect(isoWeekday("2026-11-22")).toBe(7); // Sunday
    expect(defaultDayType("2026-11-20")).toBe("weekday"); // Friday
    expect(defaultDayType("2026-11-21")).toBe("weekend"); // Saturday
    expect(defaultDayType("2026-11-22")).toBe("weekend");
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-11-14", "2026-11-21")).toBe(7);
    expect(daysBetween("2026-11-21", "2026-11-14")).toBe(-7);
  });
});

describe("labels", () => {
  it("formats times", () => {
    expect(minutesToHHMM(545)).toBe("09:05");
    expect(minutesToLabel(0)).toBe("12:00 AM");
    expect(minutesToLabel(540)).toBe("9:00 AM");
    expect(minutesToLabel(720)).toBe("12:00 PM");
    expect(minutesToLabel(810)).toBe("1:30 PM");
  });

  it("formats durations and dates", () => {
    expect(durationLabel(60)).toBe("1 hour");
    expect(durationLabel(90)).toBe("1.5 hours");
    expect(durationLabel(480)).toBe("8 hours");
    expect(longDateLabel("2026-11-21")).toBe("Saturday, November 21, 2026");
  });
});
