import { describe, expect, it } from "vitest";
import { loyaltyStanding, stampsNeededInWords, type LoyaltyVisit } from "./loyalty";

/** A visit at 10:00 on a day, or later that day with `hour`. */
function visit(day: string, id = day, extra: Partial<LoyaltyVisit> = {}, hour = 10): LoyaltyVisit {
  return { bookingId: id, day, startAt: Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00Z`), usedFreeHour: false, photography: false, ...extra };
}

const FIVE = ["2026-11-02", "2026-11-05", "2026-11-09", "2026-11-12", "2026-11-16"];

describe("one free hour for five visits", () => {
  it("is not earned by four days, and is earned by the fifth", () => {
    expect(loyaltyStanding(FIVE.slice(0, 4).map((day) => visit(day)), 5)).toMatchObject({ earned: 0, towardsNext: 4, milestones: [] });
    expect(loyaltyStanding(FIVE.map((day) => visit(day)), 5)).toEqual({
      days: FIVE.map((day) => ({ day, bookingId: day })),
      adjustment: 0,
      stamps: 5,
      earned: 1,
      towardsNext: 0,
      needed: 5, // the count starts again
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

  it("does not count a photography session (the owner, 2026-11-15)", () => {
    const sessions = FIVE.map((day) => visit(day, day, { photography: true }));
    expect(loyaltyStanding(sessions, 5)).toMatchObject({ days: [], stamps: 0, earned: 0, towardsNext: 0, milestones: [] });
    // Four rentals and a session are four visits. A rental on the day of a session counts that day.
    const mixed = [...FIVE.slice(0, 4).map((day) => visit(day)), visit(FIVE[4], "session", { photography: true })];
    expect(loyaltyStanding(mixed, 5)).toMatchObject({ earned: 0, towardsNext: 4 });
    expect(loyaltyStanding([...mixed, visit(FIVE[4], "rental", {}, 15)], 5)).toMatchObject({ earned: 1, milestones: ["rental"] });
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
    const nothing = { days: [], adjustment: 0, stamps: 0, earned: 0, towardsNext: 0, milestones: [] };
    expect(loyaltyStanding(FIVE.map((day) => visit(day)), 0)).toEqual({ ...nothing, needed: 0 });
    expect(loyaltyStanding([], 5)).toEqual({ ...nothing, needed: 5 });
  });
});

describe("stamps an administrator adds or takes away", () => {
  const three = FIVE.slice(0, 3).map((day) => visit(day));

  it("count on top of the visits, without touching them", () => {
    // Three visits and two stamps added by hand: five stamps, one free hour.
    expect(loyaltyStanding(three, 5, 2)).toEqual({
      days: FIVE.slice(0, 3).map((day) => ({ day, bookingId: day })),
      adjustment: 2,
      stamps: 5,
      earned: 1,
      towardsNext: 0,
      needed: 5,
      milestones: ["2026-11-09"], // the third visit completed it: the two added stamps count as if they came first
    });
    // One taken away: two stamps left.
    expect(loyaltyStanding(three, 5, -1)).toMatchObject({ stamps: 2, earned: 0, towardsNext: 2, needed: 3 });
  });

  it("never go below nothing, and say so honestly when no visit completed a free hour", () => {
    expect(loyaltyStanding(three, 5, -10)).toMatchObject({ adjustment: -10, stamps: 0, earned: 0, towardsNext: 0, needed: 5 });
    // Seven stamps for someone who has never booked here: one free hour, and no visit that stands for it.
    expect(loyaltyStanding([], 5, 7)).toMatchObject({ stamps: 7, earned: 1, towardsNext: 2, needed: 3, milestones: [null] });
    // Ten added to someone with three visits: the first two free hours came from the correction alone.
    expect(loyaltyStanding(three, 5, 10)).toMatchObject({ stamps: 13, earned: 2, milestones: [null, null] });
  });

  it("give each free hour a different visit, so that one visit never stands for two", () => {
    const ten = Array.from({ length: 10 }, (_, index) => visit(`2026-10-${String(index + 1).padStart(2, "0")}`));
    for (const extra of [-3, -1, 0, 1, 4, 5, 9]) {
      const named = loyaltyStanding(ten, 5, extra).milestones.filter((id) => id !== null);
      expect(new Set(named).size, `with ${extra} stamps by hand`).toBe(named.length);
    }
    expect(loyaltyStanding(ten, 5, 1).milestones).toEqual(["2026-10-04", "2026-10-09"]);
  });

  it("ignore a number that is not whole", () => {
    expect(loyaltyStanding(three, 5, 1.5)).toMatchObject({ adjustment: 0, stamps: 3 });
    expect(loyaltyStanding(three, 5, Number.NaN)).toMatchObject({ adjustment: 0, stamps: 3 });
  });
});

describe("the words under the row of circles", () => {
  it("say how many stamps are still needed", () => {
    expect(stampsNeededInWords(2)).toBe("two more stamps");
    expect(stampsNeededInWords(1)).toBe("one more stamp");
    expect(stampsNeededInWords(5)).toBe("five more stamps");
    expect(stampsNeededInWords(12)).toBe("12 more stamps");
  });
});
