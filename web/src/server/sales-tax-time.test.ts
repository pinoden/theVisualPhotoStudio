import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { bookings, promoCodes } from "@/db/schema";
import { createAdminBooking, moveBooking } from "./appointments";
import type { AuthUser } from "./auth";
import { toBookingViews } from "./bookings";
import type { EmailTransport } from "./email";
import { loyaltyStandingOf } from "./loyalty";
import { cancelBooking } from "./manage";
import { sendPayLink } from "./pay-links";
import { loadReceipts } from "./receipts";
import { loadSettings, saveSetting } from "./settings";
import { completeVisits, queueReminders, runScheduledTasks } from "./tasks";
import { BASE_URL, createTestWorld, expectOk, h, hoursAfter, NOW, OWNER_EMAIL, type TestWorld } from "./testing";

/**
 * Sales tax as time passes: what the scheduled tasks do with taxed bookings (reminders, completed visits and stamps,
 * review requests, reserved amounts taken later, refunds tried again, payment links found paid). Blanche for two hours
 * on a weekday is $176, and $187.44 with 6.5% tax.
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
  expect(await saveSetting(world.db, "salesTaxBasisPoints", 650)).toBe(true);
});

const JANE = "jane@example.com";
/** Five weekdays. world.book() books 10:00 to 12:00 studio time. */
const DAYS = ["2026-11-18", "2026-11-19", "2026-11-20", "2026-11-23", "2026-11-24"];
const evening = (date: string) => new Date(`${date}T23:00:00-05:00`);
const START = new Date("2026-11-18T15:00:00Z");
const rowOf = async (ref: string) => (await world.db.select().from(bookings).where(eq(bookings.ref, ref)))[0];
const viewOf = async (ref: string, now: Date) => (await toBookingViews(world.db, [await rowOf(ref)], now))[0];
const delivered: string[] = [];
const email: EmailTransport = {
  name: "test",
  async send(message) {
    delivered.push(message.to);
    return { ok: true };
  },
};
const tick = (now: Date) => runScheduledTasks(world.db, { ...world.manageDeps({ now }), email });
const studioMakes = async () =>
  expectOk(
    await createAdminBooking(
      world.db,
      owner,
      { studioIds: [world.ids.blanche], date: DAYS[0], startMinute: h(10), durationMinutes: 120, customer: { name: "Dana Diaz", email: "dana@example.com", phone: "407-555-0133" } },
      { now: NOW, baseUrl: BASE_URL },
    ),
  );

describe("taxed visits, as the days pass", () => {
  it("each earns its stamp, and the fifth a free hour, which takes an hour's price off before the tax", async () => {
    const sent: number[] = [];
    for (const date of DAYS) {
      expectOk(await world.book({ date }));
      sent.push((await completeVisits(world.db, evening(date), BASE_URL)).codes);
    }
    expect(sent).toEqual([0, 0, 0, 0, 1]);
    // The first four visits each say where the client stands; the fifth sends the free hour instead.
    expect(await world.emails("loyalty_progress")).toHaveLength(4);
    const [code] = await world.db.select().from(promoCodes).orderBy(asc(promoCodes.createdAt));
    expect(code).toMatchObject({ kind: "free_hour", source: "loyalty", email: JANE });

    const free = expectOk(await world.book({ date: "2026-12-02", promoCode: code.code }, { now: evening(DAYS[4]) }));
    expect(free.totalCents).toBe(9372);
    expect(await rowOf(free.ref)).toMatchObject({ promoDiscountCents: 8800, taxCents: 572, totalCents: 9372 });
    // The visit made with the free hour earns no stamp.
    const before = await loyaltyStandingOf(world.db, JANE, await loadSettings(world.db));
    await completeVisits(world.db, evening("2026-12-02"), BASE_URL);
    expect((await rowOf(free.ref)).status).toBe("completed");
    expect((await loyaltyStandingOf(world.db, JANE, await loadSettings(world.db))).towardsNext).toBe(before.towardsNext);
  });

  it("asks for one review a day later, and keeps the receipt's tax once the visit is over", async () => {
    const booked = expectOk(await world.book());
    const end = hoursAfter(START, 2);
    expect(await tick(hoursAfter(end, 2))).toMatchObject({ visitsCompleted: 1, reviewRequestsQueued: 0 });
    expect(await tick(hoursAfter(end, 24))).toMatchObject({ reviewRequestsQueued: 1 });
    expect(await tick(hoursAfter(end, 48))).toMatchObject({ visitsCompleted: 0, reviewRequestsQueued: 0 });
    const { receipts, unpaid } = await loadReceipts(world.db, JANE);
    expect(unpaid).toEqual([]);
    expect(receipts[0]).toMatchObject({ ref: booked.ref, totalCents: 18744, paidCents: 18744, dueCents: 0 });
    expect(receipts[0].lines.at(-1)).toEqual({ label: "Sales tax (6.5%)", cents: 1144 });
  });
});

describe("the reminder before a taxed visit", () => {
  it("says what is still to pay with its tax for a booking the studio made, and nothing for one paid by card", async () => {
    const made = await studioMakes();
    expectOk(await world.book({ startMinute: h(14) }));
    expect(await queueReminders(world.db, hoursAfter(START, -24))).toBe(1);
    expect(await queueReminders(world.db, hoursAfter(START, -19))).toBe(1);
    const mails = await world.emails("booking_reminder");
    expect(mails.find((mail) => mail.body.includes(made.ref))!.body).toContain("To pay at the studio: $187.44");
    expect(mails.find((mail) => mail.toEmail === JANE)!.body).not.toContain("to pay");
  });

  it("says the new balance after a move to a dearer day, tax included", async () => {
    const booked = expectOk(await world.book());
    // Saturday: $190 and its tax, $202.35.
    expectOk(await moveBooking(world.db, owner, booked.ref, { date: "2026-11-21", startMinute: h(10), countsAsClientMove: false }, NOW));
    expect(await queueReminders(world.db, hoursAfter(new Date("2026-11-21T15:00:00Z"), -24))).toBe(1);
    expect((await world.emails("booking_reminder"))[0].body).toContain("$14.91");
  });
});

describe("money the scheduled tasks settle later", () => {
  it("takes a reserved amount that could not be taken at once: the whole total, tax included", async () => {
    world.failCaptures = "Square is not answering.";
    const booked = expectOk(await world.book());
    expect(await viewOf(booked.ref, NOW)).toMatchObject({ heldCents: 18744, receivedCents: 0, dueCents: 0 });
    world.failCaptures = null;
    expect(await tick(hoursAfter(NOW, 1))).toMatchObject({ reservationsTaken: 1 });
    expect(await viewOf(booked.ref, hoursAfter(NOW, 1))).toMatchObject({ heldCents: 0, receivedCents: 18744, dueCents: 0, taxCents: 1144 });
  });

  it("sends a refund that failed again, at the same amount", async () => {
    // Twelve days ahead: inside the terms' refund, less the 5% fee.
    const booked = expectOk(await world.book({ date: "2026-11-27" }));
    world.failRefunds = "Square is not answering.";
    expect(await cancelBooking(world.db, booked.ref, { kind: "token", token: booked.manageToken }, world.manageDeps())).toMatchObject({ ok: true });
    world.failRefunds = null;
    expect(await tick(hoursAfter(NOW, 1))).toMatchObject({ refundsSucceeded: 1, refundsFailed: 0 });
    expect(world.refundCalls.map((call) => call.amountCents)).toEqual([17807, 17807]);
    expect(await viewOf(booked.ref, hoursAfter(NOW, 1))).toMatchObject({ refundedCents: 17807, taxCents: 1144 });
  });

  it("finds a payment link paid, for the total with its tax", async () => {
    const made = await studioMakes();
    expect(await sendPayLink(world.db, owner, made.ref, world.manageDeps())).toMatchObject({ ok: true, amountCents: 18744 });
    const [link] = world.links;
    expect(link.request.amountCents).toBe(18744);
    link.state = { state: "paid", paymentId: `mock_pay_${link.linkId}`, amountCents: link.request.amountCents };
    expect(await tick(hoursAfter(NOW, 1))).toMatchObject({ payLinksPaid: 1 });
    expect(await viewOf(made.ref, hoursAfter(NOW, 1))).toMatchObject({ receivedCents: 18744, dueCents: 0 });
  });
});

describe("the owners change the rate between a booking and its visit", () => {
  it("leaves the booking's total and tax as they were through every task", async () => {
    const booked = expectOk(await world.book());
    await saveSetting(world.db, "salesTaxBasisPoints", 1000);
    await tick(hoursAfter(START, -24));
    await tick(hoursAfter(START, 30));
    expect(await rowOf(booked.ref)).toMatchObject({ status: "completed", taxBasisPoints: 650, taxCents: 1144, totalCents: 18744 });
  });
});
