import type { DbLike } from "@/db/client";
import { sessionsOf, type Service } from "@/lib/domain/services";
import { studioCombinationError } from "@/lib/catalog-view";
import { combinedStarts, type StudioDay } from "@/lib/domain/availability";
import { findPrice } from "@/lib/domain/pricing";
import { isIsoDate, type IsoDate } from "@/lib/domain/time";
import { loadDayAvailability } from "./availability";
import { dayTypeFor, type Catalog } from "./catalog";

/**
 * Which days of a month a booking of these studios and this length fits on (the owner's brief of 2026-11-22, item 3):
 * the days the booking page's month calendar lets a client choose. A day counts only when the booking can really be
 * made on it: inside the booking window and the notice, at a length the studios are priced for on that kind of day (a
 * session the studio offers, for photography), and with a start time at which every studio, and for photography the
 * photographer, is free for the whole length. That is the same rule the start times follow (`combinedStarts`), from the
 * same day's availability (`loadDayAvailability`), so a day offered here always offers a time.
 */

export interface MonthFitsInput {
  /** "2026-12". */
  month: string;
  studioIds: string[];
  durationMinutes: number;
  photography: boolean;
  /** Whose session, for a session (question 69). */
  service?: Service;
}

export type MonthFitsResult = { ok: true; month: string; days: Record<IsoDate, boolean> } | { ok: false; message: string };

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Every date of a month, "2026-12-01" to "2026-12-31". */
export function datesOfMonth(month: string): IsoDate[] {
  const match = MONTH.exec(month);
  if (!match) return [];
  const [year, number] = [Number(match[1]), Number(match[2])];
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return Array.from({ length: last }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`).filter(isIsoDate);
}

export async function loadMonthFits(db: DbLike, catalog: Catalog, input: MonthFitsInput, now: Date): Promise<MonthFitsResult> {
  const dates = datesOfMonth(input.month);
  if (dates.length === 0) return { ok: false, message: "Choose a month." };
  const ids = [...new Set(input.studioIds)];
  if (ids.length === 0 || !ids.every((id) => catalog.studios.some((studio) => studio.id === id))) return { ok: false, message: "Choose a studio." };
  if (studioCombinationError(catalog.studios, ids)) return { ok: false, message: studioCombinationError(catalog.studios, ids)! };
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes <= 0) return { ok: false, message: "Choose a length." };
  const service = input.service ?? "photography";
  if (input.photography && (ids.length !== 1 || !sessionsOf(catalog.photoPackages, service).some((pack) => pack.studioId === ids[0] && pack.durationMinutes === input.durationMinutes))) {
    return { ok: false, message: "Choose a session this studio offers." };
  }

  const days: Record<IsoDate, boolean> = {};
  for (const date of dates) {
    const dayType = dayTypeFor(catalog, date);
    const priced = input.photography || ids.every((id) => findPrice(id, dayType, input.durationMinutes, catalog.rules) !== null);
    if (!priced) {
      days[date] = false;
      continue;
    }
    // A day outside the booking window comes back with its problem and reads nothing from the database.
    const day = await loadDayAvailability(db, catalog, date, now, { withPhotographer: input.photography ? service : false });
    if (day.problem) {
      days[date] = false;
      continue;
    }
    const held = ids.map((id) => day.days.find((studio) => studio.studioId === id));
    if (held.some((studio) => !studio)) {
      days[date] = false;
      continue;
    }
    const all = held as StudioDay[];
    if (input.photography) {
      if (!day.photographer) {
        days[date] = false;
        continue;
      }
      all.push(day.photographer);
    }
    days[date] =
      combinedStarts(all, {
        durationMinutes: input.durationMinutes,
        incrementMinutes: catalog.settings.slotIncrementMinutes,
        earliestStartMinute: day.earliestStartMinute,
      }).length > 0;
  }
  return { ok: true, month: input.month, days };
}
