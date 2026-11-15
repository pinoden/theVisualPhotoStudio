import { describe, expect, it } from "vitest";
import {
  availabilityGrid,
  combinedStarts,
  freeStarts,
  isStartFree,
  studiosFreeAt,
  type StudioDay,
} from "./availability";

const h = (hours: number) => hours * 60;

function day(studioId: string, busy: [number, number][] = [], overrides: Partial<StudioDay> = {}): StudioDay {
  return {
    studioId,
    openMinute: h(9),
    closeMinute: h(19),
    bufferMinutes: 10,
    busy: busy.map(([start, end]) => ({ start, end })),
    ...overrides,
  };
}

const hourly = { durationMinutes: 60, incrementMinutes: 60 };

describe("freeStarts", () => {
  it("offers every slot that fits inside opening hours", () => {
    expect(freeStarts(day("a"), hourly)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map(h));
    // A 3-hour booking must end by closing time.
    expect(freeStarts(day("a"), { durationMinutes: 180, incrementMinutes: 60 }).at(-1)).toBe(h(16));
  });

  it("offers nothing on a closed day", () => {
    expect(freeStarts(day("a", [], { openMinute: null, closeMinute: null }), hourly)).toEqual([]);
  });

  it("offers nothing for a duration longer than the day", () => {
    expect(freeStarts(day("a"), { durationMinutes: h(11), incrementMinutes: 60 })).toEqual([]);
  });

  it("keeps clean-up time on both sides of an existing booking", () => {
    // Existing booking 12:00-13:00, stored with its 10 minute buffer.
    const d = day("a", [[h(12), h(13) + 10]]);
    const starts = freeStarts(d, { durationMinutes: 60, incrementMinutes: 30 });
    expect(starts).not.toContain(h(11)); // would end at 12:00 with no clean-up time
    expect(starts).not.toContain(h(11) + 30);
    expect(starts).not.toContain(h(12));
    expect(starts).not.toContain(h(13)); // previous booking still cleaning up
    expect(starts).toContain(h(10) + 30); // ends 11:30, clean by 11:40
    expect(starts).toContain(h(13) + 30);
  });

  it("respects the minimum notice", () => {
    const starts = freeStarts(day("a"), { ...hourly, earliestStartMinute: h(14) + 15 });
    expect(starts[0]).toBe(h(15));
  });

  it("blocks the whole day when a block covers it", () => {
    expect(freeStarts(day("a", [[0, 1440]]), hourly)).toEqual([]);
  });
});

describe("isStartFree", () => {
  it("rejects starts that are off the slot grid, outside hours or malformed", () => {
    const d = day("a");
    expect(isStartFree(d, h(10), hourly)).toBe(true);
    expect(isStartFree(d, h(10) + 7, hourly)).toBe(false);
    expect(isStartFree(d, h(8), hourly)).toBe(false);
    expect(isStartFree(d, h(18) + 30, { durationMinutes: 60, incrementMinutes: 30 })).toBe(false);
    expect(isStartFree(d, 600.5, hourly)).toBe(false);
    expect(isStartFree(d, h(10), { durationMinutes: -60, incrementMinutes: 60 })).toBe(false);
    expect(isStartFree(d, h(10), { durationMinutes: 0, incrementMinutes: 60 })).toBe(false);
  });
});

describe("several studios", () => {
  const a = day("a", [[h(10), h(11) + 10]]);
  const b = day("b", [[h(14), h(16) + 10]]);
  const c = day("c", [], { openMinute: h(12), closeMinute: h(18) });

  it("studio-first flow: only times when every chosen studio is free", () => {
    const starts = combinedStarts([a, b], hourly);
    expect(starts).not.toContain(h(10));
    expect(starts).not.toContain(h(14));
    expect(starts).not.toContain(h(15));
    // 9:00-10:00 in studio a would leave no clean-up time before its 10:00 booking.
    expect(starts).not.toContain(h(9));
    expect(starts).toEqual([h(12), h(17), h(18)]);
    // Later opening of studio c limits the set further.
    expect(combinedStarts([a, b, c], hourly)[0]).toBe(h(12));
    expect(combinedStarts([], hourly)).toEqual([]);
  });

  it("time-first flow: which studios are free at a chosen time", () => {
    const grid = availabilityGrid([a, b, c], hourly);
    expect(grid.times[0]).toBe(h(9));
    expect(studiosFreeAt(grid, h(9))).toEqual(["b"]);
    expect(studiosFreeAt(grid, h(10))).toEqual(["b"]);
    expect(studiosFreeAt(grid, h(12))).toEqual(["a", "b", "c"]);
    expect(studiosFreeAt(grid, h(14))).toEqual(["a", "c"]);
    expect(studiosFreeAt(grid, h(20))).toEqual([]);
  });
});
