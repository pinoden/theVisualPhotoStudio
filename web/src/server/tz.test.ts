import { describe, expect, it } from "vitest";
import { clockChangeOn, dayBoundsUtc, formatInstant, formatRange, localDateOf, localMinuteOn, localMinuteOnFloor, localToUtc } from "./tz";

const iso = (d: Date) => d.toISOString();

describe("studio time zone (America/New_York)", () => {
  it("converts winter and summer wall-clock times", () => {
    expect(iso(localToUtc("2026-11-18", 600))).toBe("2026-11-18T15:00:00.000Z"); // EST, UTC-5
    expect(iso(localToUtc("2026-07-15", 600))).toBe("2026-07-15T14:00:00.000Z"); // EDT, UTC-4
  });

  it("handles the days the clocks change", () => {
    // Spring forward, 2027-03-14: 10:00 is already daylight time.
    expect(iso(localToUtc("2027-03-14", 600))).toBe("2027-03-14T14:00:00.000Z");
    // Fall back, 2026-11-01: 10:00 is standard time again.
    expect(iso(localToUtc("2026-11-01", 600))).toBe("2026-11-01T15:00:00.000Z");
    // Those local days are 23 and 25 hours long.
    const spring = dayBoundsUtc("2027-03-14");
    expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(23);
    const fall = dayBoundsUtc("2026-11-01");
    expect((fall.end.getTime() - fall.start.getTime()) / 3_600_000).toBe(25);
  });

  it("knows the hour the clocks skip or show twice, and that other days have none", () => {
    expect(clockChangeOn("2027-03-14")).toEqual({ start: 120, end: 180 }); // 2:00 to 3:00 never happens
    expect(clockChangeOn("2026-11-01")).toEqual({ start: 60, end: 120 }); // 1:00 to 2:00 happens twice
    expect(clockChangeOn("2027-11-07")).toEqual({ start: 60, end: 120 });
    expect(clockChangeOn("2027-03-13")).toBeNull();
    expect(clockChangeOn("2026-11-18")).toBeNull();
    expect(clockChangeOn("not a date")).toBeNull();
  });

  it("treats minute 1440 as midnight of the next day", () => {
    expect(iso(localToUtc("2026-11-18", 1440))).toBe(iso(localToUtc("2026-11-19", 0)));
    expect(iso(localToUtc("2027-03-13", 1440))).toBe(iso(localToUtc("2027-03-14", 0)));
    expect(() => localToUtc("2026-11-18", -1)).toThrow();
    expect(() => localToUtc("2026-11-18", 10.5)).toThrow();
    expect(() => localToUtc("2026-02-30", 600)).toThrow();
  });

  it("finds the studio's calendar date of an instant", () => {
    expect(localDateOf(new Date("2026-11-18T03:00:00Z"))).toBe("2026-11-17"); // 10 PM the evening before
    expect(localDateOf(new Date("2026-11-18T05:00:00Z"))).toBe("2026-11-18"); // midnight
  });

  it("measures instants in minutes of a given local day, clamped to that day", () => {
    const tenAm = new Date("2026-11-18T15:00:00Z");
    expect(localMinuteOn(tenAm, "2026-11-18")).toBe(600);
    expect(localMinuteOn(tenAm, "2026-11-19")).toBe(0); // instant is before that day
    expect(localMinuteOn(tenAm, "2026-11-17")).toBe(1440); // instant is after that day
    // A partial minute counts as taken (round up for ends, down for starts).
    const tenAndABit = new Date("2026-11-18T15:00:30Z");
    expect(localMinuteOn(tenAndABit, "2026-11-18")).toBe(601);
    expect(localMinuteOnFloor(tenAndABit, "2026-11-18")).toBe(600);
  });

  it("formats times for people in studio time", () => {
    const start = new Date("2026-11-21T15:00:00Z");
    const end = new Date("2026-11-21T17:00:00Z");
    expect(formatInstant(start)).toBe("Sat, Nov 21, 2026, 10:00 AM");
    expect(formatRange(start, end)).toEqual({ day: "Saturday, November 21, 2026", time: "10:00 AM – 12:00 PM" });
  });
});
