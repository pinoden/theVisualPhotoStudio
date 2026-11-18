import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookings, membershipMinutes, settings } from "@/db/schema";
import { releaseExpiredHolds } from "./availability";
import { getBookingByToken, quoteSelection } from "./bookings";
import { loyaltyStandingOf } from "./loyalty";
import { cancelBooking, getManageChoices, ownerCancelBooking, requestRescheduleCode, type Actor } from "./manage";
import { takeBookingMinutes } from "./membership-minutes";
import { cancelMembership, joinMembership, listPlans, membershipsOf, type PlanView } from "./memberships";
import { MOCK_TOKEN_DECLINED, MOCK_TOKEN_OK } from "./payments";
import { loadSettings } from "./settings";
import { BASE_URL, createTestWorld, expectOk, FAR, h, hoursAfter, NOW, OWNER_EMAIL, type TestWorld } from "./testing";

/** Follow-up 3, step 3 of the plan of 2026-11-18: spending a membership's minutes on bookings. */
let world: TestWorld;
let plans: PlanView[];
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  plans = await listPlans(world.db);
});

const JANE = { name: "Jane Smith", email: "jane@example.com", phone: "407-555-0100" };
const SATURDAY = "2026-11-21";

/** Jane buys a plan: its code. */
async function join(planName = "Studio Paris, 5 hours a month", customer = JANE): Promise<string> {
  const plan = plans.find((candidate) => candidate.name === planName)!;
  const joined = await joinMembership(
    world.db,
    { planId: plan.id, customer, acceptTerms: true, paymentToken: MOCK_TOKEN_OK, requestId: randomUUID() },
    { now: NOW, payments: world.provider, baseUrl: BASE_URL, ownerEmail: OWNER_EMAIL },
  );
  return expectOk(joined).membership.code;
}
const left = async (email = JANE.email) => (await membershipsOf(world.db, email))[0].minutesLeft;
const rowOf = async (ref: string) => (await world.db.select().from(bookings).where(eq(bookings.ref, ref)))[0];
const byToken = (token: string): Actor => ({ kind: "token", token });
const change = (key: string, value: unknown) => world.db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });

describe("paying for a booking with membership minutes", () => {
  it("pays the whole studio time with the code, so no card is needed, and takes the minutes", async () => {
    const code = await join();
    const preview = await quoteSelection(world.db, { studioIds: [world.ids.paris], date: FAR, durationMinutes: 120, promoCode: code.toLowerCase(), email: "Jane@Example.com" }, NOW);
    expect(preview).toMatchObject({ ok: true, promo: null, membership: { code, minutesLeft: 300, weekendDifference: true }, quote: { membershipMinutes: 120, membershipCents: 13600, totalCents: 0 } });

    const booked = expectOk(await world.book({ studioIds: [world.ids.paris], date: FAR, promoCode: code, paymentToken: undefined }));
    expect(booked.totalCents).toBe(0);
    expect(world.charges).toHaveLength(1); // the membership's first month only
    expect(await left()).toBe(180);
    const row = await rowOf(booked.ref);
    expect(row).toMatchObject({ status: "confirmed", membershipMinutes: 120, membershipCents: 13600, totalCents: 0 });
    const lines = await world.db.select().from(membershipMinutes).where(eq(membershipMinutes.bookingId, row.id));
    expect(lines).toEqual([expect.objectContaining({ minutes: -120, kind: "booking", note: `Booking ${booked.ref}`, actor: "the site" })]);

    const view = (await getBookingByToken(world.db, booked.ref, booked.manageToken))!;
    expect(view).toMatchObject({ membershipMinutes: 120, membershipCents: 13600, totalCents: 0 });
    const [mail] = await world.emails("booking_confirmation");
    expect(mail.body).toContain("Total: $136\nPaid with your membership hours (2 hours): $136\n");
    // Nothing was left to pay, and no card was charged: no line says one was.
    expect(mail.body).not.toContain("Charged to your card");
  });

  it("uses what is left on a longer booking, which pays the share of the time it does not cover", async () => {
    const code = await join();
    expectOk(await world.book({ studioIds: [world.ids.paris], date: FAR, startMinute: h(9), durationMinutes: 240, promoCode: code, paymentToken: undefined }));
    expect(await left()).toBe(60);
    // Four hours in Paris on a weekday are $245: the last hour of minutes covers a quarter, and three quarters are paid.
    const longer = expectOk(await world.book({ studioIds: [world.ids.paris], date: FAR, startMinute: h(14), durationMinutes: 240, promoCode: code }));
    expect(longer.totalCents).toBe(18375);
    expect(world.charges.at(-1)).toMatchObject({ amountCents: 18375 });
    expect(await left()).toBe(0);
    expect(await rowOf(longer.ref)).toMatchObject({ membershipMinutes: 60, membershipCents: 6125 });
    // Nothing left: the code is refused.
    expect(await world.book({ studioIds: [world.ids.paris], date: "2026-12-10", promoCode: code })).toMatchObject({
      ok: false,
      code: "invalid_code",
      message: "No hours are left on this membership. Each month paid adds its hours.",
    });
  });

  it("covers the weekday price of the time at weekends while the owners keep that rule, and weekend time in full otherwise", async () => {
    const code = await join();
    // Paris for two hours: $136 on a weekday, $144 on a Saturday.
    const saturday = expectOk(await world.book({ studioIds: [world.ids.paris], date: SATURDAY, promoCode: code }));
    expect(saturday.totalCents).toBe(800);
    await change("memberWeekendDifference", false);
    const free = expectOk(await world.book({ studioIds: [world.ids.paris], date: SATURDAY, startMinute: h(14), promoCode: code, paymentToken: undefined }));
    expect(free.totalCents).toBe(0);
  });

  it("is for the studios of its plan, a bundle's one at a time or together, and pays add-ons never", async () => {
    const code = await join("Paris and Dayglow, 5 hours a month");
    expectOk(await world.book({ studioIds: [world.ids.dayglow], date: FAR, promoCode: code, paymentToken: undefined }));
    const together = expectOk(await world.book({ studioIds: [world.ids.paris, world.ids.dayglow], date: FAR, startMinute: h(14), promoCode: code, addons: [] , paymentToken: undefined }));
    expect(together.totalCents).toBe(0);
    expect(await left()).toBe(60); // two bookings of two hours each: the studios together count once
    expect(await world.book({ studioIds: [world.ids.blanche], date: FAR, promoCode: code })).toMatchObject({
      ok: false,
      message: "This membership's hours are for Studio Dayglow or Studio Paris, so they cannot pay for this booking.",
    });
  });

  it("is refused for a photography session, another client, and a booking of the other kind of money", async () => {
    const code = await join();
    expect(await world.book({ studioIds: [world.ids.paris], date: "2026-12-12", durationMinutes: 60, photography: true, promoCode: code })).toMatchObject({
      ok: false,
      message: "Membership hours are for studio rentals: they cannot pay for a photography session.",
    });
    expect(await world.book({ studioIds: [world.ids.paris], date: FAR, promoCode: code, customer: { ...JANE, email: "bob@example.com" } })).toMatchObject({
      ok: false,
      message: "That code belongs to a different email address. Use the address the code was sent to.",
    });
    expect(await world.book({ studioIds: [world.ids.paris], date: FAR, promoCode: code }, { processor: "square" })).toMatchObject({ ok: false, code: "invalid_code" });
    expect(await left()).toBe(300);
  });

  it("keeps the hours of a cancelled membership usable", async () => {
    const code = await join();
    const [membership] = await membershipsOf(world.db, JANE.email);
    expectOk(await cancelMembership(world.db, { email: JANE.email, role: "customer" }, membership.id, { now: NOW, payments: world.provider, baseUrl: BASE_URL }));
    expectOk(await world.book({ studioIds: [world.ids.paris], date: FAR, promoCode: code, paymentToken: undefined }));
    expect(await left()).toBe(180);
  });

  it("gives the minutes back when the card is refused or the hold on the time runs out, and never spends them twice", async () => {
    const code = await join();
    // Longer than what is left, so a card pays the rest; the card is refused.
    expectOk(await world.book({ studioIds: [world.ids.paris], date: FAR, startMinute: h(9), durationMinutes: 240, promoCode: code, paymentToken: undefined }));
    expect(await world.book({ studioIds: [world.ids.paris], date: FAR, startMinute: h(14), durationMinutes: 240, promoCode: code, paymentToken: MOCK_TOKEN_DECLINED })).toMatchObject({
      ok: false,
      code: "payment_failed",
    });
    expect(await left()).toBe(60);

    const held = expectOk(await world.book({ studioIds: [world.ids.paris], date: "2026-12-10", durationMinutes: 60, promoCode: code, paymentToken: undefined }));
    expect(await left()).toBe(0);
    await world.db.update(bookings).set({ status: "pending_payment", holdExpiresAt: NOW }).where(eq(bookings.ref, held.ref));
    await releaseExpiredHolds(world.db, hoursAfter(NOW, 1));
    expect(await left()).toBe(60);

    // Two bookings at once: the second finds fewer minutes than it was priced with, and takes none.
    const [membership] = await membershipsOf(world.db, JANE.email);
    const other = await rowOf(held.ref);
    expect(await takeBookingMinutes(world.db, { membershipId: membership.id, bookingId: other.id, minutes: 90, ref: held.ref })).toBe(false);
    expect(await left()).toBe(60);
  });

  it("never spends the same minutes twice when two bookings are made at the same moment (the tester's check)", async () => {
    const code = await join();
    // Two 4-hour bookings at once, each paid in full by the 5 hours on the code: one is made.
    const [a, b] = await Promise.all([
      world.book({ studioIds: [world.ids.paris], date: FAR, startMinute: h(9), durationMinutes: 240, customer: JANE, promoCode: code, paymentToken: undefined }),
      world.book({ studioIds: [world.ids.paris], date: FAR, startMinute: h(14), durationMinutes: 240, customer: JANE, promoCode: code, paymentToken: undefined }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await left()).toBe(60);
  });

  it("counts as a visit for loyalty, as any visit does", async () => {
    const code = await join();
    const booked = expectOk(await world.book({ studioIds: [world.ids.paris], date: FAR, promoCode: code, paymentToken: undefined }));
    await world.db.update(bookings).set({ status: "completed" }).where(eq(bookings.ref, booked.ref));
    expect((await loyaltyStandingOf(world.db, JANE.email, await loadSettings(world.db))).stamps).toBe(1);
  });
});

describe("cancelling or moving a booking paid with minutes", () => {
  it("gives the minutes back when the client cancels 48 hours or more ahead, and says so before and after", async () => {
    const code = await join();
    const booked = expectOk(await world.book({ studioIds: [world.ids.paris], date: FAR, promoCode: code, paymentToken: undefined }));
    const choices = (await getManageChoices(world.db, booked.ref, byToken(booked.manageToken), NOW))!;
    expect(choices.cancel.text).toContain("The membership time it used (2 hours) goes back to your membership.");
    // Moving it online is not offered: cancel and book again, or ask the studio.
    expect(choices.reschedule).toMatchObject({ allowed: false, offered: true });
    expect(choices.reschedule.text).toContain("is moved by cancelling it and booking the new time");
    expect(await requestRescheduleCode(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps())).toMatchObject({ ok: false });

    expect(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps(), "something else")).toMatchObject({ ok: false, code: "changed" });
    const cancelled = expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps(), choices.cancel.text));
    expect(cancelled.message).toContain("goes back to your membership");
    expect(await left()).toBe(300);
    const [mail] = await world.emails("booking_cancelled");
    expect(mail.body).toContain("The membership time it used (2 hours) goes back to your membership.");
  });

  it("keeps them used when the client cancels later than that", async () => {
    const code = await join();
    // Sunday 2026-11-15 at 16:00, 30 hours ahead.
    const soon = expectOk(await world.book({ studioIds: [world.ids.paris], date: "2026-11-15", startMinute: h(16), promoCode: code }));
    const choices = (await getManageChoices(world.db, soon.ref, byToken(soon.manageToken), NOW))!;
    expect(choices.cancel.text).toContain("The membership time it used (2 hours) is not given back, as the booking is cancelled less than 2 days before it starts.");
    expectOk(await cancelBooking(world.db, soon.ref, byToken(soon.manageToken), world.manageDeps(), choices.cancel.text));
    expect(await left()).toBe(180);
  });

  it("gives them back when the studio cancels a visit that has not started", async () => {
    const code = await join();
    const booked = expectOk(await world.book({ studioIds: [world.ids.paris], date: FAR, promoCode: code, paymentToken: undefined }));
    expectOk(await ownerCancelBooking(world.db, booked.ref, { refundCents: 0 }, world.manageDeps()));
    expect(await left()).toBe(300);
    const [mail] = await world.emails("booking_cancelled");
    expect(mail.body).toContain("The membership time it used (2 hours) goes back to your membership.\nPlease contact us with any questions.");
  });
});
