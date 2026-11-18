/**
 * The loyalty rule: a client who visits on five separate days gets one free
 * hour. Pure functions, so the rule is the same wherever it is asked.
 *
 * A visit that counts gives one stamp. The owner's rule (2026-11-15):
 *  - A day counts once, however many bookings or studios it had.
 *  - A visit made as a bundle of studios counts like any other.
 *  - A visit on which a free hour was used does not count towards the next one.
 *  - A photography session with the in-house photographer does not count
 *    (the owner, 2026-11-15): the reward is for renting the studios.
 *  - The count starts again after each free hour, so every fifth stamp earns one.
 *
 * An administrator can add or take away stamps by hand (a visit from before
 * the site counted them, a correction). Those changes are a number on top of
 * the days: they never touch the visits themselves.
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
  /** A photography session, not a studio rental. */
  photography: boolean;
}

export interface LoyaltyStanding {
  /** The days that count, oldest first, each with the booking that stands for it. One stamp each. */
  days: { day: IsoDate; bookingId: string }[];
  /** Stamps an administrator added (positive) or took away (negative), in total. */
  adjustment: number;
  /** Every stamp: one for each day that counts, plus or minus the administrator's changes. Never below 0. */
  stamps: number;
  /** Free hours earned so far: one for every `visitsPerReward` stamps. */
  earned: number;
  /** Stamps counted towards the next free hour. */
  towardsNext: number;
  /** Stamps still needed for the next free hour. */
  needed: number;
  /**
   * For each free hour earned, in order, the booking whose day completed it.
   * Null when no single visit did: an administrator's stamps completed it.
   */
  milestones: (string | null)[];
}

export function loyaltyStanding(visits: LoyaltyVisit[], visitsPerReward: number, adjustment = 0): LoyaltyStanding {
  const extra = Number.isInteger(adjustment) ? adjustment : 0;
  if (!Number.isInteger(visitsPerReward) || visitsPerReward < 1) {
    return { days: [], adjustment: extra, stamps: 0, earned: 0, towardsNext: 0, needed: 0, milestones: [] };
  }
  const ordered = visits
    .filter((visit) => !visit.usedFreeHour && !visit.photography)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.startAt - b.startAt || (a.bookingId < b.bookingId ? -1 : 1)));

  const days: LoyaltyStanding["days"] = [];
  for (const visit of ordered) {
    if (days.at(-1)?.day !== visit.day) days.push({ day: visit.day, bookingId: visit.bookingId });
  }

  const stamps = Math.max(0, days.length + extra);
  const earned = Math.floor(stamps / visitsPerReward);
  const towardsNext = stamps % visitsPerReward;
  const milestones = Array.from({ length: earned }, (_, index) => {
    // An administrator's stamps count as if they had come first, so each free hour still belongs to one day.
    const dayNumber = (index + 1) * visitsPerReward - extra;
    return dayNumber >= 1 && dayNumber <= days.length ? days[dayNumber - 1].bookingId : null;
  });
  return { days, adjustment: extra, stamps, earned, towardsNext, needed: visitsPerReward - towardsNext, milestones };
}

/** "two more stamps", "one more stamp": the words under the row of circles. */
export function stampsNeededInWords(needed: number): string {
  const words = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  const count = needed >= 0 && needed < words.length ? words[needed] : String(needed);
  return `${count} more ${needed === 1 ? "stamp" : "stamps"}`;
}
