/**
 * Availability for one calendar day. Pure functions over minutes from local
 * midnight. Both booking flows are views over the same result:
 *   - studio first: `combinedStarts` for the chosen studios
 *   - time first:   `availabilityGrid`, then `studiosFreeAt` a chosen time
 */

export interface Interval {
  start: number;
  end: number;
}

export interface StudioDay {
  studioId: string;
  /** null when the studio is closed that day. */
  openMinute: number | null;
  closeMinute: number | null;
  /** Clean-up time kept free after every booking. */
  bufferMinutes: number;
  /** Time already taken (bookings including their buffer, and blocks). */
  busy: Interval[];
}

export interface SlotOptions {
  durationMinutes: number;
  incrementMinutes: number;
  /** Starts before this minute are not offered (minimum notice). */
  earliestStartMinute?: number;
}

function overlaps(aStart: number, aEnd: number, b: Interval): boolean {
  return aStart < b.end && aEnd > b.start;
}

/** True when the studio can host [start, start + duration) on that day. */
export function isStartFree(day: StudioDay, start: number, opts: SlotOptions): boolean {
  const { durationMinutes, incrementMinutes } = opts;
  if (day.openMinute === null || day.closeMinute === null) return false;
  if (!Number.isInteger(start) || !Number.isInteger(durationMinutes) || durationMinutes <= 0) return false;
  if (incrementMinutes <= 0) return false;
  if (start < day.openMinute || start + durationMinutes > day.closeMinute) return false;
  if ((start - day.openMinute) % incrementMinutes !== 0) return false;
  if (opts.earliestStartMinute !== undefined && start < opts.earliestStartMinute) return false;
  // The new booking also needs its own clean-up time before the next one.
  const occupiedEnd = start + durationMinutes + day.bufferMinutes;
  return !day.busy.some((b) => overlaps(start, occupiedEnd, b));
}

export function freeStarts(day: StudioDay, opts: SlotOptions): number[] {
  if (day.openMinute === null || day.closeMinute === null) return [];
  if (!(opts.incrementMinutes > 0) || !(opts.durationMinutes > 0)) return [];
  const result: number[] = [];
  for (let t = day.openMinute; t + opts.durationMinutes <= day.closeMinute; t += opts.incrementMinutes) {
    if (isStartFree(day, t, opts)) result.push(t);
  }
  return result;
}

/** Start times at which every one of the given studios is free. */
export function combinedStarts(days: StudioDay[], opts: SlotOptions): number[] {
  if (days.length === 0) return [];
  const [first, ...rest] = days;
  return freeStarts(first, opts).filter((t) => rest.every((d) => isStartFree(d, t, opts)));
}

export interface AvailabilityGrid {
  /** Every start time at which at least one studio is free, ascending. */
  times: number[];
  byStudio: Record<string, number[]>;
}

export function availabilityGrid(days: StudioDay[], opts: SlotOptions): AvailabilityGrid {
  const byStudio: Record<string, number[]> = {};
  const all = new Set<number>();
  for (const day of days) {
    const starts = freeStarts(day, opts);
    byStudio[day.studioId] = starts;
    for (const t of starts) all.add(t);
  }
  return { times: [...all].sort((a, b) => a - b), byStudio };
}

export function studiosFreeAt(grid: AvailabilityGrid, start: number): string[] {
  return Object.entries(grid.byStudio)
    .filter(([, starts]) => starts.includes(start))
    .map(([studioId]) => studioId);
}
