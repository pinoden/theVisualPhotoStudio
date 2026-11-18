import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { bookings, priceRules, promoCodes, specialDates, studioHolds } from "@/db/schema";
import { cardReceiptOf, createAdminBooking, getAppointment, moveBooking, moveOptions } from "./appointments";
import type { AuthUser } from "./auth";
import { toBookingViews } from "./bookings";
import { loadCatalog } from "./catalog";
import { listEvents } from "./history";
import { ownerRefund } from "./manage";
import { joinMembership, listPlans } from "./memberships";
import { MOCK_TOKEN_OK, mockProvider } from "./payments";
import { issuePromo } from "./promos";
import { priceOnNewDay } from "./reprice";
import { saveSetting } from "./settings";
import { recordHandRefund, recordStudioPayment } from "./studio-payments";
import { BASE_URL, createTestWorld, daysAfter, expectOk, FAR, h, NOW, OWNER_EMAIL, type TestWorld } from "./testing";

/** Follow-up 5: a booking the studio moves to a day of the other kind takes that day's price. */
let world: TestWorld;
let owner: AuthUser;
let sam: AuthUser; // staff, who may move bookings but not see prices
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser(OWNER_EMAIL, "owner", "Olivia");
  sam = await world.addUser("sam@studio.test", "staff", "Sam");
});

/** FAR is a Wednesday; the Thursday after it, and the Saturday. */
const THURSDAY = "2026-12-10";
const SATURDAY = "2026-12-12";
const to = (date: string, startMinute = h(10)) => ({ date, startMinute, countsAsClientMove: false });

const rowOf = async (ref: string) => (await world.db.select().from(bookings).where(eq(bookings.ref, ref)))[0];
const holdPrices = async (ref: string) =>
  (await world.db.select({ priceCents: studioHolds.priceCents }).from(studioHolds).innerJoin(bookings, eq(bookings.id, studioHolds.bookingId)).where(eq(bookings.ref, ref))).map(
    (hold) => hold.priceCents,
  );
const paymentCard = async (ref: string) => (await getAppointment(world.db, owner, ref, NOW))!.payments!;
const movedEmail = async () => (await world.emails("booking_moved")).at(-1)!;
const lastNote = async (ref: string) => (await listEvents(world.db, (await rowOf(ref)).id)).at(-1)!.note;

async function setPrice(slug: string, dayType: "weekday" | "weekend", minutes: number, cents: number | null) {
  const where = and(eq(priceRules.studioId, world.ids[slug]), eq(priceRules.dayType, dayType), eq(priceRules.durationMinutes, minutes));
  if (cents === null) await world.db.delete(priceRules).where(where);
  else await world.db.update(priceRules).set({ priceCents: cents }).where(where);
}

describe("moving a booking to a day of the other kind", () => {
  it("keeps the price on a day of the same kind, even when the prices have changed since", async () => {
    const { ref } = expectOk(await world.book({ date: FAR }));
    await setPrice("blanche", "weekday", 120, 20000);
    expect(await moveOptions(world.db, owner, ref, THURSDAY, NOW)).toMatchObject({ ok: true, price: null });
    expectOk(await moveBooking(world.db, owner, ref, to(THURSDAY), NOW));
    expect(await rowOf(ref)).toMatchObject({ totalCents: 17600, studiosSubtotalCents: 17600 });
    expect(await holdPrices(ref)).toEqual([17600]);
    expect(await lastNote(ref)).not.toContain("Priced as");
    expect((await movedEmail()).body).not.toContain("priced as");
  });

  it("prices a booking moved to a weekend at the weekend price: the client owes the difference, and is told", async () => {
    const { ref } = expectOk(await world.book({ date: FAR }));
    expect(await moveOptions(world.db, owner, ref, SATURDAY, NOW)).toMatchObject({
      ok: true,
      price: { dayType: "weekend", wasCents: 17600, nowCents: 19000, owedCents: 1400, creditLeftCents: 0, codeBackCents: 0 },
    });
    // Staff who may not see prices are told the price changes, not by how much: the page leaves the amounts out.
    expectOk(await moveBooking(world.db, owner, ref, to(SATURDAY), NOW));
    expect(await rowOf(ref)).toMatchObject({ studiosSubtotalCents: 19000, totalCents: 19000 });
    expect(await holdPrices(ref)).toEqual([19000]);
    expect(await paymentCard(ref)).toMatchObject({ paidCents: 17600, dueCents: 1400, creditLeftCents: 0 });
    expect(await lastNote(ref)).toMatch(/\. Priced as a weekend day: \$190 instead of \$176$/);
    expect((await movedEmail()).body).toContain(
      "Its new day is priced as a weekend day, so its total is now $190 instead of $176.\nStill to pay: $14, at the studio or with a payment link we email you.",
    );
    // Back to a weekday: the price it had, and nothing owed.
    expectOk(await moveBooking(world.db, owner, ref, to(FAR, h(12)), NOW));
    expect(await paymentCard(ref)).toMatchObject({ paidCents: 17600, dueCents: 0, creditLeftCents: 0 });
  });

  it("prices a booking moved to a weekday lower: what was paid beyond it is the client's, refunded when the studio agrees", async () => {
    const { ref } = expectOk(await world.book({ date: SATURDAY }));
    expectOk(await moveBooking(world.db, owner, ref, to(FAR), NOW));
    expect(await rowOf(ref)).toMatchObject({ totalCents: 17600 });
    expect(await paymentCard(ref)).toMatchObject({ paidCents: 19000, dueCents: 0, creditLeftCents: 1400, cardRefundableCents: 19000 });
    const [view] = await toBookingViews(world.db, [await rowOf(ref)], NOW);
    expect(view.creditLeftCents).toBe(1400);
    expect((await movedEmail()).body).toContain(
      "Its new day is priced as a weekday, so its total is now $176 instead of $190.\nYou have paid $14 more than that: we will refund it to you.",
    );
    // Nothing is refunded by itself: the studio does it, here to the card.
    expect(world.refundCalls).toEqual([]);
    expect(await ownerRefund(world.db, ref, { amountCents: 1400, reason: "The difference" }, world.manageDeps())).toMatchObject({ ok: true, refundCents: 1400 });
    expect(world.refundCalls.map((call) => call.amountCents)).toEqual([1400]);
    expect(await paymentCard(ref)).toMatchObject({ paidCents: 17600, dueCents: 0, creditLeftCents: 0 });
  });

  it("takes a percent code's percentage of the new price, and a free hour as the new day's hour", async () => {
    const tenOff = (await issuePromo(world.db, { kind: "percent", value: 10, source: "manual", email: "jane@example.com", expiresAt: daysAfter(NOW, 60) }))!.code;
    const percent = expectOk(await world.book({ date: FAR, promoCode: tenOff }));
    expect(await rowOf(percent.ref)).toMatchObject({ promoDiscountCents: 1760, totalCents: 15840 });
    expectOk(await moveBooking(world.db, owner, percent.ref, to(SATURDAY), NOW));
    expect(await rowOf(percent.ref)).toMatchObject({ promoDiscountCents: 1900, creditAppliedCents: 0, totalCents: 17100 });
    expect(await paymentCard(percent.ref)).toMatchObject({ dueCents: 1260 });

    const hour = (await issuePromo(world.db, { kind: "free_hour", value: 60, source: "loyalty", email: "jane@example.com", expiresAt: daysAfter(NOW, 60) }))!.code;
    const free = expectOk(await world.book({ studioIds: [world.ids.paris], date: FAR, promoCode: hour }));
    expect(await rowOf(free.ref)).toMatchObject({ promoDiscountCents: 6800, totalCents: 6800 });
    expectOk(await moveBooking(world.db, owner, free.ref, to(SATURDAY, h(14)), NOW));
    expect(await rowOf(free.ref)).toMatchObject({ studiosSubtotalCents: 14400, promoDiscountCents: 7200, totalCents: 7200 });
    expect(await paymentCard(free.ref)).toMatchObject({ dueCents: 400 });
  });

  it("lets credit pay what it paid, up to the new price: what it no longer needs goes back on its code", async () => {
    const issued = (await issuePromo(world.db, { kind: "amount", value: 25000, source: "manual", email: "jane@example.com", expiresAt: daysAfter(NOW, 90) }))!;
    const valueOf = async () => (await world.db.select({ value: promoCodes.value }).from(promoCodes).where(eq(promoCodes.id, issued.id)))[0].value;
    const { ref } = expectOk(await world.book({ date: SATURDAY, promoCode: issued.code, paymentToken: undefined }));
    expect(await rowOf(ref)).toMatchObject({ creditAppliedCents: 19000, totalCents: 0 });
    expect(await valueOf()).toBe(6000);

    expect(await moveOptions(world.db, owner, ref, FAR, NOW)).toMatchObject({ ok: true, price: { wasCents: 19000, nowCents: 17600, owedCents: 0, codeBackCents: 1400 } });
    expectOk(await moveBooking(world.db, owner, ref, to(FAR), NOW));
    expect(await rowOf(ref)).toMatchObject({ creditAppliedCents: 17600, promoDiscountCents: 17600, totalCents: 0 });
    expect(await valueOf()).toBe(7400);
    expect(await lastNote(ref)).toContain(`; $14 went back on the code ${issued.code}`);
    expect((await movedEmail()).body).toContain(
      `Its new day is priced as a weekday, so its total is now $176 instead of $190.\n$14 of the studio credit it was paid with is back on that code: ${issued.code}.`,
    );

    // Moved back to a weekend, the credit pays what it paid: the code is not spent again, and the rest is owed.
    expectOk(await moveBooking(world.db, owner, ref, to(SATURDAY), NOW));
    expect(await rowOf(ref)).toMatchObject({ creditAppliedCents: 17600, totalCents: 1400 });
    expect(await valueOf()).toBe(7400);
    expect(await paymentCard(ref)).toMatchObject({ dueCents: 1400, creditLeftCents: 0 });
  });

  it("lets membership minutes pay for the same minutes at the new day's price", async () => {
    const plan = (await listPlans(world.db)).find((candidate) => candidate.name === "Studio Paris, 5 hours a month")!;
    const joined = expectOk(
      await joinMembership(
        world.db,
        { planId: plan.id, customer: { name: "Jane Smith", email: "jane@example.com", phone: "407-555-0100" }, acceptTerms: true, paymentToken: MOCK_TOKEN_OK, requestId: randomUUID() },
        { now: NOW, payments: world.provider, baseUrl: BASE_URL, ownerEmail: OWNER_EMAIL },
      ),
    );
    const { ref } = expectOk(await world.book({ studioIds: [world.ids.paris], date: FAR, promoCode: joined.membership.code, paymentToken: undefined }));
    expect(await rowOf(ref)).toMatchObject({ membershipMinutes: 120, membershipCents: 13600, totalCents: 0 });
    // At weekends members pay the difference to the weekend price, while the owners keep that switch on (question 41).
    expectOk(await moveBooking(world.db, owner, ref, to(SATURDAY), NOW));
    expect(await rowOf(ref)).toMatchObject({ membershipMinutes: 120, membershipCents: 13600, studiosSubtotalCents: 14400, totalCents: 800 });
    expect(await paymentCard(ref)).toMatchObject({ dueCents: 800 });
    // With it off, the minutes pay for the weekend time in full.
    expect(await saveSetting(world.db, "memberWeekendDifference", false)).toBe(true);
    expectOk(await moveBooking(world.db, owner, ref, to(SATURDAY, h(14)), NOW));
    expect(await rowOf(ref)).toMatchObject({ membershipMinutes: 120, totalCents: 800 }); // the same kind of day: kept
    expectOk(await moveBooking(world.db, owner, ref, to(FAR), NOW));
    expectOk(await moveBooking(world.db, owner, ref, to(SATURDAY), NOW));
    expect(await rowOf(ref)).toMatchObject({ membershipCents: 14400, totalCents: 0 });
  });

  it("refuses a day with no price for the booking's length, and changes nothing where both kinds are priced alike", async () => {
    const { ref } = expectOk(await world.book({ date: FAR }));
    await setPrice("blanche", "weekend", 120, null);
    const why = "Studio Blanche has no weekend price for 2 hours under Prices, so the booking cannot be priced for that day. Add the price first, or choose a weekday.";
    expect(await moveOptions(world.db, owner, ref, SATURDAY, NOW)).toEqual({ ok: false, message: why });
    expect(await moveBooking(world.db, owner, ref, to(SATURDAY), NOW)).toEqual({ ok: false, reason: "no_price", message: why });
    expect(await rowOf(ref)).toMatchObject({ startAt: new Date("2026-12-09T15:00:00Z") });

    await world.db.insert(priceRules).values({ studioId: world.ids.blanche, dayType: "weekend", durationMinutes: 120, priceCents: 17600 });
    expect(await moveOptions(world.db, owner, ref, SATURDAY, NOW)).toMatchObject({ ok: true, price: null });
    expectOk(await moveBooking(world.db, owner, ref, to(SATURDAY), NOW));
    expect(await lastNote(ref)).not.toContain("Priced as");
  });

  it("never reprices a photography session, whose price is the same any day", async () => {
    const { ref } = expectOk(await world.book({ photography: true, date: "2026-12-02", durationMinutes: 60 }));
    expect(await priceOnNewDay(world.db, await rowOf(ref), SATURDAY, await loadCatalog(world.db))).toEqual({ kind: "same" });
  });
});

describe("money given back, and the price changing again (the tester's findings of 2026-11-18)", () => {
  it("owes again the remaining credit refunded to the card when the booking is moved back to the dearer day", async () => {
    const { ref } = expectOk(await world.book({ date: SATURDAY }));
    expectOk(await moveBooking(world.db, owner, ref, to(FAR), NOW));
    expect(await paymentCard(ref)).toMatchObject({ totalCents: 17600, paidCents: 19000, creditLeftCents: 1400, dueCents: 0 });
    expectOk(await ownerRefund(world.db, ref, { amountCents: 1400, reason: "The difference" }, world.manageDeps()));
    expect(await paymentCard(ref)).toMatchObject({ paidCents: 17600, creditReturnedCents: 1400, creditLeftCents: 0, dueCents: 0 });

    expect(await moveOptions(world.db, owner, ref, SATURDAY, NOW)).toMatchObject({ ok: true, price: { owedCents: 1400, creditLeftCents: 0 } });
    expectOk(await moveBooking(world.db, owner, ref, to(SATURDAY), NOW));
    expect(await paymentCard(ref)).toMatchObject({ totalCents: 19000, paidCents: 17600, dueCents: 1400, creditLeftCents: 0 });
    const [view] = await toBookingViews(world.db, [await rowOf(ref)], NOW);
    expect(view).toMatchObject({ dueCents: 1400, receivedCents: 19000, creditReturnedCents: 1400 });
    expect((await movedEmail()).body).toContain("Still to pay: $14, at the studio or with a payment link we email you.");
  });

  it("owes again what was given back by hand of a payment at the studio, once moved back", async () => {
    const made = expectOk(
      await createAdminBooking(
        world.db,
        owner,
        { studioIds: [world.ids.blanche], date: SATURDAY, startMinute: h(10), durationMinutes: 120, customer: { name: "Jane Smith", email: "jane@example.com", phone: "407-555-0100" } },
        { now: NOW, baseUrl: BASE_URL, processor: "mock" },
      ),
    );
    expectOk(await recordStudioPayment(world.db, owner, made.ref, { amountCents: 19000, method: "cash", note: "" }, NOW));
    expectOk(await moveBooking(world.db, owner, made.ref, to(FAR), NOW));
    const moved = await paymentCard(made.ref);
    expectOk(await recordHandRefund(world.db, owner, moved.payments[0].id, { amountCents: 1400, note: "The difference, in cash" }, NOW));
    expectOk(await moveBooking(world.db, owner, made.ref, to(SATURDAY), NOW));
    expect(await paymentCard(made.ref)).toMatchObject({ totalCents: 19000, paidCents: 17600, dueCents: 1400 });
  });

  it("never makes a booking owe a goodwill refund, before or after a move to a dearer day", async () => {
    const { ref } = expectOk(await world.book({ date: FAR }));
    // $20 back for a broken light, while nothing was paid beyond the price: the studio's gift.
    expectOk(await ownerRefund(world.db, ref, { amountCents: 2000, reason: "Goodwill" }, world.manageDeps()));
    expect(await paymentCard(ref)).toMatchObject({ paidCents: 15600, creditReturnedCents: 0, dueCents: 0, creditLeftCents: 0 });
    // Moved to the Saturday: it owes what its price went up by, not the gift as well.
    expectOk(await moveBooking(world.db, owner, ref, to(SATURDAY), NOW));
    expect(await paymentCard(ref)).toMatchObject({ totalCents: 19000, dueCents: 1400, creditLeftCents: 0 });
    // And moved back, what it was paid beyond the price is the client's: the gift does not use it up.
    expectOk(await moveBooking(world.db, owner, ref, to(FAR, h(12)), NOW));
    expect(await paymentCard(ref)).toMatchObject({ totalCents: 17600, dueCents: 0, creditLeftCents: 0 });
  });

  it("says nothing of a new price when a free hour still pays all of it, and keeps the new prices", async () => {
    const hour = (await issuePromo(world.db, { kind: "free_hour", value: 60, source: "loyalty", email: "jane@example.com", expiresAt: daysAfter(NOW, 60) }))!.code;
    const { ref } = expectOk(await world.book({ studioIds: [world.ids.paris], date: FAR, durationMinutes: 60, promoCode: hour, paymentToken: undefined }));
    expect(await moveOptions(world.db, owner, ref, SATURDAY, NOW)).toMatchObject({ ok: true, price: null });
    expectOk(await moveBooking(world.db, owner, ref, to(SATURDAY), NOW));
    expect(await rowOf(ref)).toMatchObject({ studiosSubtotalCents: 7200, promoDiscountCents: 7200, totalCents: 0, pricedAs: "weekend" });
    expect((await movedEmail()).body).not.toContain("priced as");
    expect(await lastNote(ref)).toMatch(/\. Priced as a weekend day: what the client pays is unchanged$/);
  });

  it("does not tell a client of a booking the studio made that a card was charged, when their hours paid all of it", async () => {
    const plan = (await listPlans(world.db)).find((candidate) => candidate.name === "Studio Paris, 5 hours a month")!;
    const joined = expectOk(
      await joinMembership(
        world.db,
        { planId: plan.id, customer: { name: "Jane Smith", email: "jane@example.com", phone: "407-555-0100" }, acceptTerms: true, paymentToken: MOCK_TOKEN_OK, requestId: randomUUID() },
        { now: NOW, payments: world.provider, baseUrl: BASE_URL, ownerEmail: OWNER_EMAIL },
      ),
    );
    expectOk(
      await createAdminBooking(
        world.db,
        owner,
        { studioIds: [world.ids.paris], date: FAR, startMinute: h(9), durationMinutes: 60, customer: { name: "Jane Smith", email: "jane@example.com", phone: "407-555-0100" }, promoCode: joined.membership.code },
        { now: NOW, baseUrl: BASE_URL, processor: "mock" },
      ),
    );
    const confirmation = (await world.emails("booking_confirmation")).at(-1)!.body;
    expect(confirmation).toContain("Total: $68\nPaid with your membership hours (1 hour): $68\n");
    expect(confirmation).not.toContain("Charged to your card");
    expect(confirmation).not.toContain("To pay at the studio");
  });
});

describe("the kind of day a booking is priced as (the tester's finding of 2026-11-18)", () => {
  it("is kept with the booking: a special date added later does not change how a move prices it", async () => {
    const { ref } = expectOk(await world.book({ date: FAR }));
    expect(await rowOf(ref)).toMatchObject({ pricedAs: "weekday" });
    // Later the owners price that Wednesday as a weekend (a holiday), and raise the weekday price of 2 hours.
    await world.db.insert(specialDates).values({ day: FAR, dayType: "weekend", note: "A holiday" });
    await setPrice("blanche", "weekday", 120, 20000);
    // To the Thursday: a weekday, as it was priced: the price stays.
    expectOk(await moveBooking(world.db, owner, ref, to(THURSDAY), NOW));
    expect(await rowOf(ref)).toMatchObject({ totalCents: 17600, pricedAs: "weekday" });
  });

  it("was filled in for the bookings made before it was kept, from their day (migration 0046)", async () => {
    const weekday = expectOk(await world.book({ date: FAR }));
    const saturday = expectOk(await world.book({ date: SATURDAY }));
    const holiday = expectOk(await world.book({ date: THURSDAY }));
    await world.db.insert(specialDates).values({ day: THURSDAY, dayType: "weekend", note: "A holiday" });
    await world.db.update(bookings).set({ pricedAs: null });
    const statements = readFileSync(path.join(process.cwd(), "drizzle", "0046_priced_as_credit_refunds.sql"), "utf8")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.includes('UPDATE "bookings"'));
    expect(statements).toHaveLength(1);
    await world.db.execute(sql.raw(statements[0]));
    for (const [ref, kind] of [
      [weekday.ref, "weekday"],
      [saturday.ref, "weekend"],
      [holiday.ref, "weekend"],
    ] as const) {
      expect((await rowOf(ref)).pricedAs).toBe(kind);
    }
  });

  it("is what a move to the other kind is priced against, whatever its old day became", async () => {
    const { ref } = expectOk(await world.book({ date: FAR }));
    await world.db.insert(specialDates).values({ day: FAR, dayType: "weekend", note: "A holiday" });
    expectOk(await moveBooking(world.db, owner, ref, to(SATURDAY), NOW));
    expect(await rowOf(ref)).toMatchObject({ totalCents: 19000, pricedAs: "weekend" });
  });
});

describe("a card payment's receipt", () => {
  it("opens the card processor's receipt, for whoever sees the booking's payments", async () => {
    const { ref } = expectOk(await world.book({ date: FAR }));
    const [line] = (await paymentCard(ref)).payments;
    expect(line).toMatchObject({ processor: "mock", byHand: false });
    expect(await cardReceiptOf(world.db, owner, ref, line.id, world.provider, NOW)).toEqual({
      ok: true,
      url: `https://squareup.test/receipt/preview/mock_${world.charges[0].idempotencyKey}`,
    });
    // Test mode's pretend processor has no receipts; one made with another processor than the one set up now is not asked about.
    expect(await cardReceiptOf(world.db, owner, ref, line.id, mockProvider, NOW)).toMatchObject({ ok: false, message: expect.stringContaining("test mode") });
    expect(await cardReceiptOf(world.db, owner, ref, line.id, { ...world.provider, name: "square" }, NOW)).toMatchObject({
      ok: false,
      message: expect.stringContaining("test mode"),
    });
    expect(await cardReceiptOf(world.db, owner, ref, randomUUID(), world.provider, NOW)).toEqual({ ok: false, message: "That card payment was not found." });
    // Staff who do not see the booking's payments are answered as for a payment that does not exist.
    expect(await cardReceiptOf(world.db, sam, ref, line.id, world.provider, NOW)).toEqual({ ok: false, message: "That card payment was not found." });
  });
});
