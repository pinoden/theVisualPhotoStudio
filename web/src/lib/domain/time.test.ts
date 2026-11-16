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
  studioToday,
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

  it("knows today on the studio's clock, whatever the device's time zone", () => {
    // 3 AM in London on 17 November is 10 PM on the 16th in New York; noon in Tokyo on the 17th is still the 16th there.
    expect(studioToday(new Date("2026-11-17T03:00:00Z"))).toBe("2026-11-16");
    expect(studioToday(new Date("2026-11-17T03:00:00+09:00"))).toBe("2026-11-16");
    expect(studioToday(new Date("2026-11-17T05:00:00Z"))).toBe("2026-11-17");
    // Midsummer, when New York is four hours behind.
    expect(studioToday(new Date("2026-07-01T03:59:00Z"))).toBe("2026-06-30");
    expect(studioToday(new Date("2026-07-01T04:00:00Z"))).toBe("2026-07-01");
  });

  it("is no date while a date is still being typed", () => {
    // A browser's date field holds these as the year is typed.
    expect(isIsoDate("0002-12-28")).toBe(false);
    expect(isIsoDate("0020-12-28")).toBe(false);
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
    // Prices can be set in steps of 15 minutes: a quarter of an hour is not "0.3 hours".
    expect(durationLabel(15)).toBe("15 minutes");
    expect(durationLabel(30)).toBe("30 minutes");
    expect(durationLabel(45)).toBe("45 minutes");
    expect(durationLabel(75)).toBe("1 hour 15 minutes");
    expect(durationLabel(165)).toBe("2 hours 45 minutes");
    expect(longDateLabel("2026-11-21")).toBe("Saturday, November 21, 2026");
  });
});
