/**
 * The loyalty rule: a client who visits on five separate days gets one free
 * hour. Pure functions, so the rule is the same wherever it is asked.
 *
 * The owner's rule (2026-11-15):
 *  - A day counts once, however many bookings or studios it had.
 *  - A visit made as a bundle of studios counts like any other.
 *  - A visit on which a free hour was used does not count towards the next one.
 *  - The count starts again after each free hour, so every fifth day earns one.
 */
import type { IsoDate } from "./time";

/** One completed visit, as far as loyalty is concerned. */
export interface LoyaltyVisit {
  bookingId: string;
  /** The studio-local date of the visit. */
  day: IsoDate;
  /** When it started (milliseconds), for a stable order within a day. */
  startAt: number;
  /** A free hour was used on this booking. */
  usedFreeHour: boolean;
}

export interface LoyaltyStanding {
  /** The days that count, oldest first, each with the booking that stands for it. */
  days: { day: IsoDate; bookingId: string }[];
  /** Free hours earned so far: one for every `visitsPerReward` days. */
  earned: number;
  /** Days counted towards the next free hour. */
  towardsNext: number;
  /** For each free hour earned, in order, the booking whose day completed it. */
  milestones: string[];
}

export function loyaltyStanding(visits: LoyaltyVisit[], visitsPerReward: number): LoyaltyStanding {
  if (!Number.isInteger(visitsPerReward) || visitsPerReward < 1) {
    return { days: [], earned: 0, towardsNext: 0, milestones: [] };
  }
  const ordered = visits
    .filter((visit) => !visit.usedFreeHour)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.startAt - b.startAt || (a.bookingId < b.bookingId ? -1 : 1)));

  const days: LoyaltyStanding["days"] = [];
  for (const visit of ordered) {
    if (days.at(-1)?.day !== visit.day) days.push({ day: visit.day, bookingId: visit.bookingId });
  }

  const earned = Math.floor(days.length / visitsPerReward);
  const milestones = Array.from({ length: earned }, (_, index) => days[(index + 1) * visitsPerReward - 1].bookingId);
  return { days, earned, towardsNext: days.length % visitsPerReward, milestones };
}
