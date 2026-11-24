import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { specialDates } from "@/db/schema";
import { promoDaysInWords, promoFitsDay, readPromoDays, type PromoDays } from "@/lib/domain/promo-days";
import { createManualCode, listCodes } from "./admin";
import { quoteSelection } from "./bookings";
import { studioCodeCheck } from "./code-balance";
import { createTestWorld, expectOk, FAR, h, NOW, type TestWorld } from "./testing";

/**
 * The days a code can be booked for (the owner's request of 2026-11-23: a Valentine's code "between January 15th and
 * February 15th", codes not for "the weekends or holidays"; question 80 in ProjectLibrary.md). FAR is Wednesday,
 * December 9, 2026.
 */
const weekdays: PromoDays = { from: null, until: null, weekdays: [1, 2, 3, 4, 5], notOnSpecialDates: true };

describe("a code's booking days, as a rule", () => {
  it("holds a booking's day to the dates, the days of the week and the holidays", () => {
    const season: PromoDays = { from: "2027-01-15", until: "2027-02-15", weekdays: [], notOnSpecialDates: false };
    expect(promoFitsDay(season, "2027-01-15", false)).toBe(true);
    expect(promoFitsDay(season, "2027-02-15", true)).toBe(true);
    expect(promoFitsDay(season, "2027-01-14", false)).toBe(false);
    expect(promoFitsDay(season, "2027-02-16", false)).toBe(false);
    expect(promoFitsDay(weekdays, "2026-12-11", false)).toBe(true); // a Friday
    expect(promoFitsDay(weekdays, "2026-12-12", false)).toBe(false); // a Saturday
    expect(promoFitsDay(weekdays, "2026-12-10", true)).toBe(false); // a holiday on a Thursday
    expect(promoFitsDay(null, "2026-12-12", true)).toBe(true);
  });

  it("says them in words, and reads what is stored with care", () => {
    expect(promoDaysInWords({ from: "2027-01-15", until: "2027-02-15", weekdays: [], notOnSpecialDates: false })).toBe("bookings from January 15 to February 15, 2027");
    expect(promoDaysInWords({ from: "2026-12-20", until: "2027-01-05", weekdays: [], notOnSpecialDates: false })).toBe("bookings from December 20, 2026 to January 5, 2027");
    expect(promoDaysInWords(weekdays)).toBe("bookings on weekdays (Monday to Friday), not on holidays");
    expect(promoDaysInWords({ from: null, until: null, weekdays: [6, 7], notOnSpecialDates: false })).toBe("bookings on weekends (Saturday and Sunday)");
    expect(promoDaysInWords({ from: null, until: null, weekdays: [1, 3], notOnSpecialDates: false })).toBe("bookings on Mondays and Wednesdays");
    expect(promoDaysInWords({ from: null, until: null, weekdays: [1, 2, 3, 4], notOnSpecialDates: false })).toBe("bookings Monday to Thursday");
    expect(promoDaysInWords({ from: null, until: null, weekdays: [1, 2, 3, 4, 5, 6, 7], notOnSpecialDates: false })).toBeNull();
    expect(readPromoDays({ from: "nonsense", weekdays: [0, 3, "4", 9], notOnSpecialDates: "yes" })).toEqual({ from: null, until: null, weekdays: [3], notOnSpecialDates: false });
    expect(readPromoDays(null)).toBeNull();
  });
});

describe("a code with booking days, at the studio and on the booking page", () => {
  let world: TestWorld;
  beforeAll(async () => {
    world = await createTestWorld();
  });
  afterAll(() => world.close());
  beforeEach(() => world.reset());

  const make = (bookingDays: PromoDays | null) =>
    createManualCode(world.db, { kind: "percent", value: 20, email: null, validDays: 60, maxUses: 10, note: "", code: "WINTER-WEEK", bookingDays }, NOW);
  const priced = (date: string) =>
    quoteSelection(world.db, { studioIds: [world.ids.paris], date, durationMinutes: 60, email: "jane@example.com", promoCode: "WINTER-WEEK" }, NOW);

  it("discounts a booking on one of its days, and refuses another day with the days it is for", async () => {
    await world.db.insert(specialDates).values({ day: "2026-12-10", dayType: "weekend", note: "Holiday" });
    expectOk(await make({ from: "2026-12-07", until: "2026-12-18", weekdays: [1, 2, 3, 4, 5], notOnSpecialDates: true }));

    const fits = expectOk(await priced(FAR));
    expect(fits.quote.promoDiscountCents).toBeGreaterThan(0);
    const days = "That code works only for bookings from December 7 to December 18, 2026, on weekdays (Monday to Friday), not on holidays.";
    const then = "Choose another date, or book without the code.";
    expect(await priced("2026-12-10")).toMatchObject({ ok: false, code: "invalid_code", message: `${days} Thursday, December 10, 2026 is a holiday. ${then}` });
    expect(await priced("2026-12-12")).toMatchObject({ ok: false, message: `${days} December 12, 2026 is a Saturday. ${then}` });
    expect(await priced("2026-12-21")).toMatchObject({ ok: false, message: `${days} Monday, December 21, 2026 is outside those dates. ${then}` });

    // The booking itself is refused so too, and the code stays unused; on its day, it is spent.
    expect(await world.book({ date: "2026-12-12", studioIds: [world.ids.paris], startMinute: h(10), durationMinutes: 60, promoCode: "WINTER-WEEK" })).toMatchObject({
      ok: false,
      code: "invalid_code",
      message: `${days} December 12, 2026 is a Saturday. ${then}`,
    });
    const booked = expectOk(await world.book({ date: FAR, studioIds: [world.ids.paris], startMinute: h(10), durationMinutes: 60, promoCode: "WINTER-WEEK" }));
    expect(booked.totalCents).toBeLessThan(expectOk(await world.book({ date: FAR, studioIds: [world.ids.blanche], startMinute: h(10), durationMinutes: 60 })).totalCents);

    // The owners and the client read the days.
    expect((await listCodes(world.db)).find((code) => code.code === "WINTER-WEEK")?.days).toBe("bookings from December 7 to December 18, 2026, on weekdays (Monday to Friday), not on holidays");
    expect((await studioCodeCheck(world.db, "WINTER-WEEK", NOW))?.balance.restrictions).toContain("For bookings from December 7 to December 18, 2026, on weekdays (Monday to Friday), not on holidays.");
  });

  it("keeps a code with every day as any day's, and refuses days that make no sense", async () => {
    expectOk(await make({ from: null, until: null, weekdays: [1, 2, 3, 4, 5, 6, 7], notOnSpecialDates: false }));
    expect((await listCodes(world.db))[0].days).toBeNull();
    expectOk(await priced("2026-12-12"));
    expect(await createManualCode(world.db, { kind: "percent", value: 10, email: null, validDays: 30, maxUses: 1, note: "", bookingDays: { from: "2026-12-20", until: "2026-12-10", weekdays: [1], notOnSpecialDates: false } }, NOW)).toMatchObject({
      ok: false,
      message: "The last booking day must be on or after the first.",
    });
    expect(await createManualCode(world.db, { kind: "percent", value: 10, email: null, validDays: 30, maxUses: 1, note: "", bookingDays: { from: null, until: null, weekdays: [], notOnSpecialDates: false } }, NOW)).toMatchObject({
      ok: false,
      message: "Tick at least one day of the week.",
    });
  });
});
