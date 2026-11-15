import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { bookings, promoCodes, settings } from "@/db/schema";
import { PROMO_MISFIT_TEXT } from "@/lib/domain/pricing";
import { createManualCode } from "./admin";
import { quoteSelection, toBookingViews, type BookingInput } from "./bookings";
import { loadCatalog } from "./catalog";
import { FREE_HOUR_MINUTES, loyaltyStandingOf } from "./loyalty";
import { cancelBooking, getManageOptions } from "./manage";
import { issuePromo } from "./promos";
import { DEFAULT_SETTINGS } from "./settings";
import { completeVisits } from "./tasks";
import { BASE_URL, createTestWorld, daysAfter, expectOk, FAR, h, hoursAfter, NEAR, NOW, type TestWorld } from "./testing";

let world: TestWorld;
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(() => world.reset());

// Eleven weekdays. world.book() books 10:00 to 12:00 studio time.
const DAYS = [
  "2026-11-18",
  "2026-11-19",
  "2026-11-20",
  "2026-11-23",
  "2026-11-24",
  "2026-11-25",
  "2026-11-27",
  "2026-11-30",
  "2026-12-01",
  "2026-12-02",
  "2026-12-03",
];
const JANE = "jane@example.com";
/** Eleven in the evening, studio time: every visit of that day ended more than two hours ago. */
const evening = (date: string) => new Date(`${date}T23:00:00-05:00`);
const codes = () => world.db.select().from(promoCodes).orderBy(asc(promoCodes.createdAt));
const byToken = (token: string) => ({ kind: "token", token }) as const;

/** Book a visit on each day and run the scheduled task that evening. Returns the free hours sent each evening. */
async function visitOn(days: string[], overrides: Partial<BookingInput> = {}): Promise<number[]> {
  const sent: number[] = [];
  for (const date of days) {
    expectOk(await world.book({ date, ...overrides }));
    sent.push((await completeVisits(world.db, evening(date), BASE_URL)).codes);
  }
  return sent;
}

describe("earning a free hour", () => {
  it("is sent when the fifth day is completed: nothing before it, one code then, and nothing again after", async () => {
    expect(await visitOn(DAYS.slice(0, 4))).toEqual([0, 0, 0, 0]);
    expect(await codes()).toHaveLength(0);

    expect(await visitOn([DAYS[4]])).toEqual([1]);
    const [code] = await codes();
    const fifth = (await world.db.select().from(bookings).orderBy(asc(bookings.startAt)))[4];
    expect(code).toMatchObject({
      kind: "free_hour",
      value: FREE_HOUR_MINUTES,
      source: "loyalty",
      email: JANE,
      maxUses: 1,
      usedCount: 0,
      originBookingId: fifth.id, // the visit that completed the five
    });
    expect(code.code).toMatch(/^THANKS-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(code.expiresAt).toEqual(daysAfter(evening(DAYS[4]), 90)); // the owner's answer of 2026-11-15: 90 days

    const [mail] = await world.emails("loyalty_code");
    expect(mail).toMatchObject({ toEmail: JANE, subject: "You have earned a free hour in the studio" });
    expect(mail.body).toContain(`Code: ${code.code}`);
    expect(mail.body).toContain("Thank you for shooting with us 5 times.");
    expect(mail.body).toContain("it cannot be used when several studios are booked together");

    // Running again sends nothing more.
    expect((await completeVisits(world.db, hoursAfter(evening(DAYS[4]), 5), BASE_URL)).codes).toBe(0);
    expect(await world.emails("loyalty_code")).toHaveLength(1);
  });

  it("counts a day once however much was booked on it, and counts a visit of several studios", async () => {
    expectOk(await world.book({ date: DAYS[0] }));
    expectOk(await world.book({ date: DAYS[0], startMinute: h(14) })); // the same day again
    expectOk(await world.book({ date: DAYS[1], studioIds: [world.ids.blanche, world.ids.paris] })); // a bundle
    expectOk(await world.book({ date: DAYS[2] }));
    expectOk(await world.book({ date: DAYS[3] }));

    // Five bookings on four days are not five visits.
    expect(await completeVisits(world.db, evening(DAYS[3]), BASE_URL)).toEqual({ completed: 5, codes: 0 });
    expect(await loyaltyStandingOf(world.db, JANE, DEFAULT_SETTINGS)).toMatchObject({ earned: 0, towardsNext: 4 });

    expect(await visitOn([DAYS[4]])).toEqual([1]);
  });

  it("does not count a no-show or a cancelled booking", async () => {
    await visitOn(DAYS.slice(0, 3));
    const noShow = expectOk(await world.book({ date: DAYS[3] }));
    await world.db.update(bookings).set({ status: "no_show" }).where(eq(bookings.ref, noShow.ref));
    const cancelled = expectOk(await world.book({ date: DAYS[4] }));
    await cancelBooking(world.db, cancelled.ref, byToken(cancelled.manageToken), world.manageDeps());

    expect((await completeVisits(world.db, evening(DAYS[4]), BASE_URL)).codes).toBe(0);
    expect(await visitOn([DAYS[5]])).toEqual([0]); // the fourth day that counts
    expect(await visitOn([DAYS[6]])).toEqual([1]); // the fifth
  });

  it("tells customers apart by their email address", async () => {
    await visitOn(DAYS.slice(0, 3));
    const eve = { name: "Eve Adams", email: "eve@example.com", phone: "407-555-0199" };
    expect(await visitOn(DAYS.slice(3, 5), { customer: eve })).toEqual([0, 0]);
    expect(await codes()).toHaveLength(0);
    expect(await loyaltyStandingOf(world.db, " Jane@Example.com ", DEFAULT_SETTINGS)).toMatchObject({ towardsNext: 3 });
    expect(await loyaltyStandingOf(world.db, eve.email, DEFAULT_SETTINGS)).toMatchObject({ towardsNext: 2 });
  });

  it("starts the count again after each free hour, and a customer can hold several", async () => {
    expect(await visitOn(DAYS.slice(0, 10))).toEqual([0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const [first, second] = await codes();
    expect([first.usedCount, second.usedCount]).toEqual([0, 0]);
    // Each lasts 90 days from the day it was earned.
    expect(first.expiresAt).toEqual(daysAfter(evening(DAYS[4]), 90));
    expect(second.expiresAt).toEqual(daysAfter(evening(DAYS[9]), 90));
    expect(first.code).not.toBe(second.code);
  });

  it("does not count a visit made with a free hour", async () => {
    await visitOn(DAYS.slice(0, 5));
    const [first] = await codes();

    // The sixth visit uses the free hour: two hours for the price of one, and no step towards the next one.
    expect(await visitOn([DAYS[5]], { promoCode: first.code })).toEqual([0]);
    expect(world.charges.at(-1)?.amountCents).toBe(17600 - 8800);
    expect(await loyaltyStandingOf(world.db, JANE, DEFAULT_SETTINGS)).toMatchObject({ earned: 1, towardsNext: 0 });

    // Four more paid days are not enough. The fifth is.
    expect(await visitOn(DAYS.slice(6, 10))).toEqual([0, 0, 0, 0]);
    expect(await visitOn([DAYS[10]])).toEqual([1]);
  });

  it("does not count a photography session with the in-house photographer (the owner, 2026-11-15)", async () => {
    // Five sessions on five days, each more than two weeks ahead, as a session has to be.
    const sessions = ["2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04"];
    expect(await visitOn(sessions, { photography: true, durationMinutes: 60 })).toEqual([0, 0, 0, 0, 0]);
    expect(await codes()).toHaveLength(0);
    expect(await loyaltyStandingOf(world.db, JANE, DEFAULT_SETTINGS)).toMatchObject({ earned: 0, towardsNext: 0, days: [] });

    // Renting a studio counts as before, also on a day that had a session.
    expect(await visitOn(["2026-12-07"])).toEqual([0]);
    expectOk(await world.book({ date: "2026-12-08", photography: true, durationMinutes: 60 }));
    expect(await visitOn(["2026-12-08"], { studioIds: [world.ids.paris], startMinute: h(14) })).toEqual([0]);
    expect((await loyaltyStandingOf(world.db, JANE, DEFAULT_SETTINGS)).days.map((entry) => entry.day)).toEqual(["2026-12-07", "2026-12-08"]);
  });

  it("does not send a second free hour for the same visits when one of them becomes a no-show afterwards", async () => {
    await visitOn(DAYS.slice(0, 5));
    const third = (await world.db.select().from(bookings).orderBy(asc(bookings.startAt)))[2];
    await world.db.update(bookings).set({ status: "no_show" }).where(eq(bookings.id, third.id));

    // Five days count again after the next visit, and the hour for five days was already sent.
    expect(await visitOn([DAYS[5]])).toEqual([0]);
    expect(await codes()).toHaveLength(1);
  });

  it("follows the owner's settings", async () => {
    await world.db.insert(settings).values([
      { key: "loyaltyVisits", value: 2 },
      { key: "loyaltyValidDays", value: 30 },
      { key: "loyaltyDelayHours", value: 0 },
    ]);
    expectOk(await world.book({ date: DAYS[0] }));
    expectOk(await world.book({ date: DAYS[1] }));
    const justEnded = new Date(`${DAYS[1]}T17:00:00Z`);
    expect(await completeVisits(world.db, justEnded, BASE_URL)).toEqual({ completed: 2, codes: 1 });
    expect((await codes())[0]).toMatchObject({ kind: "free_hour", expiresAt: daysAfter(justEnded, 30) });
    expect((await world.emails("loyalty_code"))[0].body).toContain("Thank you for shooting with us 2 times.");
  });

  it("also counts a visit that staff marked completed by hand", async () => {
    await world.db.insert(settings).values({ key: "loyaltyVisits", value: 1 });
    const booked = expectOk(await world.book());
    await world.db.update(bookings).set({ status: "completed" }).where(eq(bookings.ref, booked.ref));
    const ended = new Date(`${NEAR}T17:00:00Z`);
    expect(await completeVisits(world.db, hoursAfter(ended, 1), BASE_URL)).toEqual({ completed: 0, codes: 0 }); // too soon
    expect(await completeVisits(world.db, hoursAfter(ended, 3), BASE_URL)).toEqual({ completed: 0, codes: 1 });
  });

  it("sends nothing while loyalty is switched off, and what was earned at the customer's next visit once it is on", async () => {
    await world.db.insert(settings).values({ key: "loyaltyEnabled", value: false });
    expect(await visitOn(DAYS.slice(0, 5))).toEqual([0, 0, 0, 0, 0]);
    expect(await codes()).toHaveLength(0);

    await world.db.update(settings).set({ value: true }).where(eq(settings.key, "loyaltyEnabled"));
    // Switching it on does not mail people about visits of long ago.
    expect((await completeVisits(world.db, daysAfter(evening(DAYS[4]), 8), BASE_URL)).codes).toBe(0);
    // Their next visit does.
    expect(await visitOn([DAYS[10]])).toEqual([1]);
  });
});

describe("using a free hour", () => {
  const freeHour = async (email: string | null = JANE) =>
    (await issuePromo(world.db, {
      kind: "free_hour",
      value: FREE_HOUR_MINUTES,
      source: "loyalty",
      email,
      expiresAt: daysAfter(NOW, 60),
    }))!;
  const used = async () => (await codes())[0].usedCount;

  it("makes a one-hour booking free, with no card, once", async () => {
    const promo = await freeHour();
    const booked = expectOk(await world.book({ durationMinutes: 60, promoCode: promo.code, paymentToken: undefined }));
    expect(booked.totalCents).toBe(0);
    expect(world.charges).toHaveLength(0);

    const [row] = await world.db.select().from(bookings);
    expect(row).toMatchObject({ status: "confirmed", promoDiscountCents: 8800, creditAppliedCents: 0, promoCodeId: promo.id });
    expect((await toBookingViews(world.db, [row]))[0].promoKind).toBe("free_hour");

    expect(await world.book({ date: FAR, durationMinutes: 60, promoCode: promo.code, paymentToken: undefined })).toMatchObject({
      ok: false,
      code: "invalid_code",
      message: "That code has already been used.",
    });
  });

  it("takes the one-hour price off a longer booking: an hour and a half costs the other half hour", async () => {
    const promo = await freeHour();
    const booked = expectOk(await world.book({ durationMinutes: 90, promoCode: promo.code, expectedTotalCents: 4400 }));
    expect(booked.totalCents).toBe(13200 - 8800);
    expect(world.charges.at(-1)?.amountCents).toBe(4400);
  });

  it("works in any studio, and pays for the studio but not for add-ons", async () => {
    const pet = (await loadCatalog(world.db)).addons.find((addon) => addon.slug === "pet-fee")!;
    const promo = await freeHour();
    const booked = expectOk(
      await world.book({
        studioIds: [world.ids.dayglow],
        durationMinutes: 60,
        addons: [{ addonId: pet.id, quantity: 1 }],
        promoCode: promo.code,
      }),
    );
    expect(booked.totalCents).toBe(4000); // Dayglow's $78 hour is free; the pet fee is not
  });

  it("is refused when several studios are booked together, and stays unused", async () => {
    const promo = await freeHour();
    const bundle = { studioIds: [world.ids.blanche, world.ids.paris], durationMinutes: 60, promoCode: promo.code };
    const refusal = { ok: false, status: 422, code: "invalid_code", message: PROMO_MISFIT_TEXT.several_studios };

    expect(await world.book(bundle)).toEqual(refusal);
    expect(await quoteSelection(world.db, { ...bundle, date: NEAR, email: JANE }, NOW)).toEqual(refusal);
    expect(await used()).toBe(0);
    expect(world.charges).toHaveLength(0);
    expect(await world.db.select().from(bookings)).toHaveLength(0);
  });

  it("belongs to the customer it was sent to", async () => {
    const promo = await freeHour();
    const eve = { name: "Eve Adams", email: "eve@example.com", phone: "407-555-0199" };
    expect(await world.book({ durationMinutes: 60, promoCode: promo.code, customer: eve })).toMatchObject({
      ok: false,
      code: "invalid_code",
    });
    expect(await used()).toBe(0);
  });

  it("comes back when the booking is cancelled", async () => {
    const promo = await freeHour();
    const booked = expectOk(await world.book({ date: FAR, durationMinutes: 90, promoCode: promo.code }));
    expect(await used()).toBe(1);

    const result = expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    expect(result.refundCents).toBe(4400 - 220); // what the card paid, less the 5% fee
    expect(result.message).toContain("The code you used for this booking can be used again.");
    expect(await used()).toBe(0);
  });

  it("keeps its value when the booking is moved: the reschedule code is worth the whole booking", async () => {
    const promo = await freeHour();
    const booked = expectOk(await world.book({ durationMinutes: 90, promoCode: promo.code }));
    expect((await getManageOptions(world.db, booked.ref, byToken(booked.manageToken), NOW))?.reschedule).toEqual({
      allowed: true,
      creditCents: 13200,
      discountCents: 8800,
    });
  });

  it("can be handed out by the owner, for visits made before the site counted them", async () => {
    const made = await createManualCode(
      world.db,
      { kind: "free_hour", value: FREE_HOUR_MINUTES, email: JANE, validDays: 30, maxUses: 1, note: "Regular since 2024" },
      NOW,
    );
    expect(made.ok).toBe(true);
    const [code] = await codes();
    expect(code).toMatchObject({ kind: "free_hour", value: 60, source: "manual", email: JANE, maxUses: 1 });

    const booked = expectOk(await world.book({ durationMinutes: 60, promoCode: code.code, paymentToken: undefined }));
    expect(booked.totalCents).toBe(0);
    // A free hour from the owner is still a free hour: that visit does not count towards the next one.
    await completeVisits(world.db, evening(NEAR), BASE_URL);
    expect(await loyaltyStandingOf(world.db, JANE, DEFAULT_SETTINGS)).toMatchObject({ towardsNext: 0 });
  });
});
