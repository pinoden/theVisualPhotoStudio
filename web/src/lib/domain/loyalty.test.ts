import { describe, expect, it } from "vitest";
import { loyaltyStanding, type LoyaltyVisit } from "./loyalty";

/** A visit at 10:00 on a day, or later that day with `hour`. */
function visit(day: string, id = day, extra: Partial<LoyaltyVisit> = {}, hour = 10): LoyaltyVisit {
  return { bookingId: id, day, startAt: Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00Z`), usedFreeHour: false, ...extra };
}

const FIVE = ["2026-11-02", "2026-11-05", "2026-11-09", "2026-11-12", "2026-11-16"];

describe("one free hour for five visits", () => {
  it("is not earned by four days, and is earned by the fifth", () => {
    expect(loyaltyStanding(FIVE.slice(0, 4).map((day) => visit(day)), 5)).toMatchObject({ earned: 0, towardsNext: 4, milestones: [] });
    expect(loyaltyStanding(FIVE.map((day) => visit(day)), 5)).toEqual({
      days: FIVE.map((day) => ({ day, bookingId: day })),
      earned: 1,
      towardsNext: 0,
      milestones: ["2026-11-16"], // the booking whose day completed the five
    });
  });

  it("counts a day once, however many bookings it had", () => {
    const visits = [
      visit("2026-11-02", "morning"),
      visit("2026-11-02", "afternoon", {}, 14),
      visit("2026-11-02", "evening", {}, 18),
      visit("2026-11-05"),
    ];
    const standing = loyaltyStanding(visits, 5);
    expect(standing.days).toEqual([
      { day: "2026-11-02", bookingId: "morning" }, // the first booking of the day stands for it
      { day: "2026-11-05", bookingId: "2026-11-05" },
    ]);
    expect(standing.towardsNext).toBe(2);
  });

  it("does not count a visit on which a free hour was used", () => {
    const visits = [...FIVE.map((day) => visit(day)), visit("2026-11-20", "free", { usedFreeHour: true })];
    expect(loyaltyStanding(visits, 5)).toMatchObject({ earned: 1, towardsNext: 0 });
    // A paid booking on the same day still counts that day.
    expect(loyaltyStanding([...visits, visit("2026-11-20", "paid", {}, 15)], 5)).toMatchObject({ earned: 1, towardsNext: 1 });
  });

  it("starts the count again after each free hour: every fifth day earns one", () => {
    const days = Array.from({ length: 12 }, (_, index) => `2026-10-${String(index + 1).padStart(2, "0")}`);
    expect(loyaltyStanding(days.map((day) => visit(day)), 5)).toMatchObject({
      earned: 2,
      towardsNext: 2,
      milestones: ["2026-10-05", "2026-10-10"],
    });
  });

  it("gives the same answer whatever order the visits come in", () => {
    const visits = [visit("2026-11-02", "late", {}, 15), ...FIVE.map((day) => visit(day))];
    const shuffled = [visits[3], visits[0], visits[5], visits[1], visits[4], visits[2]];
    expect(loyaltyStanding(shuffled, 5)).toEqual(loyaltyStanding(visits, 5));
  });

  it("follows the owner's number of visits, and earns nothing for a number that makes no sense", () => {
    expect(loyaltyStanding(FIVE.map((day) => visit(day)), 2)).toMatchObject({ earned: 2, towardsNext: 1 });
    expect(loyaltyStanding(FIVE.map((day) => visit(day)), 0)).toEqual({ days: [], earned: 0, towardsNext: 0, milestones: [] });
    expect(loyaltyStanding([], 5)).toEqual({ days: [], earned: 0, towardsNext: 0, milestones: [] });
  });
});
