import { minutesToLabel } from "./domain/time";

/** A start time in an admin's list: "9:00 AM – 11:00 AM", and for an owner's "any time" what it passes over (question 79). */
export function startLabel(minute: number, durationMinutes: number, passes?: Record<number, string[]>): string {
  const time = `${minutesToLabel(minute)} – ${minutesToLabel(minute + durationMinutes)}`;
  const over = passes?.[minute];
  return over && over.length > 0 ? `${time} — passes over ${over.length === 1 ? "1 thing" : `${over.length} things`}` : time;
}
