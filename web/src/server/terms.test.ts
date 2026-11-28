import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookings, promoCodes, settings } from "@/db/schema";
import { getAppointment, moveBooking } from "./appointments";
import type { AuthUser } from "./auth";
import { cancelBooking, getManageChoices, getManageOptions, requestRescheduleCode, type Actor } from "./manage";
import { DEFAULT_SETTINGS } from "./settings";
import { storedTerms, termsAtBooking, termsFor } from "./terms";
import { createTestWorld, daysAfter, expectOk, FAR, h, NOW, OWNER_EMAIL, type TestWorld } from "./testing";

/**
 * Question 10, the owner's answer of 2026-11-17: changed terms apply only to bookings made afterwards; a booking keeps
 * the policies in effect when it was made.
 */
let world: TestWorld;
let owner: AuthUser;
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser(OWNER_EMAIL, "owner", "Olivia");
});

const byToken = (token: string): Actor => ({ kind: "token", token });
const row = async (ref: string) => (await world.db.select().from(bookings).where(eq(bookings.ref, ref)))[0];
const change = (key: string, value: unknown) =>
  world.db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });

describe("a booking keeps the terms it was made under", () => {
  it("keeps them with the booking from the moment it is made", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    expect((await row(booked.ref)).terms).toEqual({
      refundWindowHours: 168,
      refundFeePercent: 5,
      rescheduleCutoffHours: 24,
      cancelCodeEnabled: true,
      cancelCodeUntilHours: 48,
      maxReschedules: 1,
      rescheduleFeeCents: 2000,
      creditValidDays: 90,
      memberReturnHours: 48,
      lateCancelKeepsCode: false,
      weekdayCodeOnWeekdays: true,
    });
  });

  it("is refunded by the window it was made under, while one made after the change follows the new window", async () => {
    // The rule before 2026-11-28, still the owners' to choose: a late cancellation gets no credit code.
    await change("cancelCodeEnabled", false);
    const before = expectOk(await world.book({ date: FAR })); // $176, 25 days ahead
    await change("refundWindowHours", 24 * 30); // 30 days: neither booking would be refundable under it
    const after = expectOk(await world.book({ date: FAR, startMinute: h(14) }));

    expect((await getManageOptions(world.db, before.ref, byToken(before.manageToken), NOW))!.cancel).toMatchObject({ why: "refund", refundCents: 16720 });
    expect((await getManageOptions(world.db, after.ref, byToken(after.manageToken), NOW))!.cancel).toMatchObject({ why: "inside_window", refundCents: 0 });
    // The words beside the button say the booking's own window.
    expect((await getManageChoices(world.db, after.ref, byToken(after.manageToken), NOW))!.cancel.text).toContain("30 days");
    expect(await cancelBooking(world.db, before.ref, byToken(before.manageToken), world.manageDeps())).toMatchObject({ ok: true, refundCents: 16720 });
  });

  it("keeps its refund fee, its moving rules and how long its code stays valid", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    await change("refundFeePercent", 20);
    await change("maxReschedules", 0); // moving switched off for bookings made from now on
    await change("rescheduleCutoffHours", 24 * 60);
    await change("creditValidDays", 10);
    const options = (await getManageOptions(world.db, booked.ref, byToken(booked.manageToken), NOW))!;
    expect(options.cancel).toMatchObject({ refundCents: 16720, feeCents: 880 }); // still 5%
    expect(options.reschedule).toMatchObject({ allowed: true, creditCents: 17600 });
    const moved = expectOk(await requestRescheduleCode(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    const [code] = await world.db.select().from(promoCodes).where(eq(promoCodes.code, moved.code));
    expect(code.expiresAt).toEqual(daysAfter(NOW, 90));
  });

  it("takes its fee for a further move as it was, whatever the fee is now", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    const moved = expectOk(await requestRescheduleCode(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    // The new booking, made with the code before the owners change the fee, keeps $20 for its next move, which the
    // studio makes (the owners' decision of 2026-11-20): the fee is added to what the booking owes.
    const second = expectOk(await world.book({ date: FAR, startMinute: h(14), promoCode: moved.code, paymentToken: undefined }));
    await change("rescheduleFeeCents", 5000);
    expect((await getManageOptions(world.db, second.ref, byToken(second.manageToken), NOW))!.reschedule).toEqual({ allowed: false, reason: "limit_reached" });
    expect((await getManageChoices(world.db, second.ref, byToken(second.manageToken), NOW))!.reschedule.text).toContain("each further move costs $20.");
    expect(await moveBooking(world.db, owner, second.ref, { date: FAR, startMinute: h(16), countsAsClientMove: true }, NOW)).toMatchObject({ ok: true, feeCents: 2000 });
  });

  it("counts a move the studio makes at the client's request under the booking's own terms", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    await change("maxReschedules", 0);
    expectOk(await moveBooking(world.db, owner, booked.ref, { date: FAR, startMinute: h(15), countsAsClientMove: true }, NOW));
    // Moving was on when it was made: the move counts as the client's free one, and the booking is no longer refunded.
    expect((await row(booked.ref)).rescheduledCount).toBe(1);
  });

  it("shows on the appointment's page, which says when the settings have changed since", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    expect((await getAppointment(world.db, owner, booked.ref, NOW))!.terms).toMatchObject({ refundWindowHours: 168, changedSince: false });
    await change("refundWindowHours", 72);
    expect((await getAppointment(world.db, owner, booked.ref, NOW))!.terms).toMatchObject({ refundWindowHours: 168, changedSince: true });
  });

  it("follows the settings of the day for a booking made before terms were kept", async () => {
    // The rule before 2026-11-28, still the owners' to choose: a late cancellation gets no credit code.
    await change("cancelCodeEnabled", false);
    const booked = expectOk(await world.book({ date: FAR }));
    await world.db.update(bookings).set({ terms: null }).where(eq(bookings.ref, booked.ref));
    await change("refundWindowHours", 24 * 30);
    expect((await getManageOptions(world.db, booked.ref, byToken(booked.manageToken), NOW))!.cancel).toMatchObject({ why: "inside_window", refundCents: 0 });
  });
});

describe("reading terms back", () => {
  it("gives a photography session its own refund window, as it was when booked", () => {
    expect(termsAtBooking(DEFAULT_SETTINGS, true).refundWindowHours).toBe(DEFAULT_SETTINGS.photoRefundWindowHours);
    expect(termsAtBooking(DEFAULT_SETTINGS, false).refundWindowHours).toBe(DEFAULT_SETTINGS.refundWindowHours);
    // Kept with the session, the window stays when the photography window changes.
    const kept = { photographerId: "p", terms: termsAtBooking(DEFAULT_SETTINGS, true) };
    expect(termsFor(kept, { ...DEFAULT_SETTINGS, photoRefundWindowHours: 24 }).refundWindowHours).toBe(336);
  });

  it("takes a value that is not a whole number within its setting's range from the settings", () => {
    const booking = { photographerId: null, terms: { refundWindowHours: -1, refundFeePercent: 7.5, rescheduleCutoffHours: "24", maxReschedules: 2, rescheduleFeeCents: 999_999_999 } };
    expect(storedTerms(booking, DEFAULT_SETTINGS)).toEqual({
      refundWindowHours: 168,
      refundFeePercent: 5,
      rescheduleCutoffHours: 24,
      cancelCodeEnabled: true,
      cancelCodeUntilHours: 48,
      maxReschedules: 2,
      rescheduleFeeCents: 2000,
      creditValidDays: 90,
      memberReturnHours: 48,
      lateCancelKeepsCode: false,
      weekdayCodeOnWeekdays: true,
    });
    expect(storedTerms({ photographerId: null, terms: "nonsense" }, DEFAULT_SETTINGS)).toEqual(termsAtBooking(DEFAULT_SETTINGS, false));
    // Whether a late cancellation gives a code back is kept as yes or no; a booking from before it was kept follows the setting.
    expect(storedTerms({ photographerId: null, terms: { lateCancelKeepsCode: true } }, DEFAULT_SETTINGS).lateCancelKeepsCode).toBe(true);
    expect(storedTerms({ photographerId: null, terms: { lateCancelKeepsCode: "yes" } }, DEFAULT_SETTINGS).lateCancelKeepsCode).toBe(false);
    expect(storedTerms({ photographerId: null, terms: {} }, { ...DEFAULT_SETTINGS, lateCancelKeepsCode: true }).lateCancelKeepsCode).toBe(true);
    // And so is the rule of 2026-11-28, that a weekday's booking is moved to a weekday.
    expect(storedTerms({ photographerId: null, terms: { weekdayCodeOnWeekdays: false } }, DEFAULT_SETTINGS).weekdayCodeOnWeekdays).toBe(false);
    expect(storedTerms({ photographerId: null, terms: {} }, DEFAULT_SETTINGS).weekdayCodeOnWeekdays).toBe(true);
    expect(storedTerms({ photographerId: null, terms: { weekdayCodeOnWeekdays: 1 } }, { ...DEFAULT_SETTINGS, weekdayCodeOnWeekdays: false }).weekdayCodeOnWeekdays).toBe(false);
  });
});
