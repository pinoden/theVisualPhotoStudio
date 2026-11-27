import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { bookings, emailOutbox, membershipPayments, memberships, paymentLinks, payments } from "@/db/schema";
import { FAKE_PAYMENT_TOKEN } from "@/lib/fake-payment";
import { createAdminBooking, getAppointment, cardReceiptOf } from "./appointments";
import type { AuthUser } from "./auth";
import { getBookingByToken, toBookingViews } from "./bookings";
import { deliverPendingEmails, loginCodeEmail, queueEmail, type EmailTransport } from "./email";
import { NOT_SENT_FAKE_PAYMENT, withFakePayments } from "./fake-payment";
import { askStudioToMove, cancelBooking } from "./manage";
import { cancelMembership, joinMembership, listPlans } from "./memberships";
import { fakePayLink, getPayPage, sendPayLink } from "./pay-links";
import { mockProvider, resolvePayments, type PaymentProvider } from "./payments";
import { runScheduledTasks } from "./tasks";
import { BASE_URL, createTestWorld, expectOk, h, hoursAfter, NOW, OWNER_EMAIL, type TestWorld } from "./testing";

/**
 * FAKE PAYMENT (temporary): the "Fake Payment" button pays as a card does, with no card and no money, and no email
 * about what it paid for is sent. Delete this file with the button.
 */
let world: TestWorld;
let owner: AuthUser;
/** The test processor, as `resolvePayments` sets a test one up. */
let provider: PaymentProvider;
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser(OWNER_EMAIL, "owner", "Olivia");
  provider = withFakePayments(world.provider, mockProvider.memberships);
});

const JANE = "jane@example.com";
const ROBIN = { name: "Robin Real", email: "robin@example.com", phone: "407-555-0111" };
/** `world.book()` books Wednesday November 18, 10:00 to 12:00 studio time. */
const START = new Date("2026-11-18T15:00:00Z");

const fakeBooking = async (overrides: Parameters<TestWorld["book"]>[0] = {}) =>
  expectOk(await world.book({ paymentToken: FAKE_PAYMENT_TOKEN, ...overrides }, { payments: provider }));
const rowOf = async (ref: string) => (await world.db.select().from(bookings).where(eq(bookings.ref, ref)))[0];
const paymentsOf = async (ref: string) => world.db.select().from(payments).where(eq(payments.bookingId, (await rowOf(ref)).id));
const deps = (now = NOW) => world.manageDeps({ now, payments: provider });

/** Sends what waits, and says who got what. */
async function deliver(now = NOW) {
  const sent: string[] = [];
  const transport: EmailTransport = {
    name: "test",
    async send(message) {
      sent.push(`${message.to}: ${message.subject}`);
      return { ok: true };
    },
  };
  await deliverPendingEmails(world.db, transport, now, 100);
  return sent;
}
const outbox = () => world.db.select().from(emailOutbox).orderBy(asc(emailOutbox.createdAt));
const heldKinds = async () => (await outbox()).filter((row) => row.error === NOT_SENT_FAKE_PAYMENT).map((row) => row.kind).sort();

describe("a booking paid with the button", () => {
  it("is confirmed and paid on the calendar like one paid by card, with the card processor never asked", async () => {
    const booked = await fakeBooking();
    expect(await rowOf(booked.ref)).toMatchObject({ status: "confirmed", totalCents: 17600, moneyKind: "test" });
    expect(await paymentsOf(booked.ref)).toEqual([expect.objectContaining({ status: "succeeded", provider: "mock", amountCents: 17600, providerPaymentId: expect.stringMatching(/^fake_17600_/) })]);
    expect((await toBookingViews(world.db, [await rowOf(booked.ref)], NOW))[0]).toMatchObject({ receivedCents: 17600, dueCents: 0, heldCents: 0 });
    expect([world.charges, world.captures]).toEqual([[], []]);
    // The time is taken: nobody else books it.
    expect(await world.book({ customer: ROBIN })).toMatchObject({ ok: false, code: "slot_taken" });
    expect(await cardReceiptOf(world.db, owner, booked.ref, (await paymentsOf(booked.ref))[0].id, provider, NOW)).toMatchObject({ ok: false, message: expect.stringContaining("Fake Payment") });
  });

  it("sends no email about it, while another client's go out, and keeps why on the unsent one", async () => {
    await fakeBooking();
    expectOk(await world.book({ startMinute: h(14), customer: ROBIN }, { payments: provider }));
    expect(await deliver()).toEqual([expect.stringMatching(/^robin@example\.com: Booking confirmed/)]);
    const [mine] = (await outbox()).filter((row) => row.toEmail === JANE);
    expect(mine).toMatchObject({ kind: "booking_confirmation", sentAt: null, error: NOT_SENT_FAKE_PAYMENT });
    // It stays unsent however often the queue is gone through.
    expect(await deliver(hoursAfter(NOW, 5))).toEqual([]);
  });

  it("still sends a sign-in code to the client who used it, so that they can look at their account", async () => {
    await fakeBooking();
    await queueEmail(world.db, loginCodeEmail(JANE, "123456", 10));
    expect(await deliver()).toEqual([expect.stringMatching(/^jane@example\.com: .*123456/)]);
  });

  it("sends neither the reminder, the review request nor a notice to the studio that names it", async () => {
    await fakeBooking();
    // Another client, whose booking is asked to be moved (one waiting to be moved is not completed, so it is not Jane's).
    const asked = await fakeBooking({ startMinute: h(14), customer: { name: "Sam Second", email: "sam@example.com", phone: "407-555-0122" } });
    await runScheduledTasks(world.db, { ...deps(hoursAfter(START, -20)), email: null });
    expectOk(await askStudioToMove(world.db, asked.ref, { kind: "token", token: asked.manageToken }, "Could we come an hour later?", deps(hoursAfter(START, -20))));
    await runScheduledTasks(world.db, { ...deps(hoursAfter(START, 30)), email: null });
    const queued = await outbox();
    expect(queued.map((row) => row.kind)).toEqual(expect.arrayContaining(["booking_confirmation", "booking_reminder", "review_request", "move_request_studio", "move_request_received"]));
    expect(queued.some((row) => row.toEmail === OWNER_EMAIL)).toBe(true);
    expect(await deliver(hoursAfter(START, 30))).toEqual([]);
    expect(await heldKinds()).toHaveLength(queued.length);
  });

  it("is cancelled and refunded as a card payment is, without the processor, and that email is not sent either", async () => {
    const booked = await fakeBooking({ date: "2026-12-09" });
    expect(await cancelBooking(world.db, booked.ref, { kind: "token", token: booked.manageToken }, deps())).toMatchObject({ ok: true });
    expect(world.refundCalls).toEqual([]);
    const view = (await getBookingByToken(world.db, booked.ref, booked.manageToken))!;
    expect(view).toMatchObject({ status: "cancelled", refundsWaitingCents: 0 });
    expect(view.refundedCents).toBeGreaterThan(0);
    expect(await deliver()).toEqual([]);
  });

  it("leaves a card payment to the processor", async () => {
    const booked = expectOk(await world.book({ customer: ROBIN, date: "2026-12-09" }, { payments: provider }));
    expect(world.charges).toHaveLength(1);
    expect(world.captures).toHaveLength(1);
    expect(await cancelBooking(world.db, booked.ref, { kind: "token", token: booked.manageToken }, deps())).toMatchObject({ ok: true });
    expect(world.refundCalls).toHaveLength(1);
  });

  it("is refused by a processor that does not offer the button, as any unknown card is", async () => {
    expect(await world.book({ paymentToken: FAKE_PAYMENT_TOKEN })).toMatchObject({ ok: false, code: "payment_failed" });
    expect(world.charges).toEqual([]);
  });
});

describe("a membership bought with the button", () => {
  it("starts with its hours, is billed by no processor, can be cancelled, and sends no email", async () => {
    const plan = (await listPlans(world.db)).find((one) => one.name === "Studio Paris, 5 hours a month")!;
    const joinDeps = { now: NOW, payments: provider, baseUrl: BASE_URL, ownerEmail: OWNER_EMAIL };
    const { membership } = expectOk(
      await joinMembership(world.db, { planId: plan.id, customer: { name: "Jane Smith", email: JANE, phone: "407-555-0100" }, acceptTerms: true, paymentToken: FAKE_PAYMENT_TOKEN, requestId: randomUUID() }, joinDeps),
    );
    expect(membership).toMatchObject({ status: "active", minutesLeft: 300, nextBilling: "2026-12-14" });
    const [row] = await world.db.select().from(memberships);
    expect(row).toMatchObject({ cardId: expect.stringMatching(/^fake_card_30000_/), subscriptionId: expect.stringMatching(/^fake_sub_2026-12-14_30000_/) });
    expect(await world.db.select().from(membershipPayments)).toEqual([expect.objectContaining({ processorId: expect.stringMatching(/^fake_30000_/), amountCents: 30000 })]);
    expect([world.charges, world.subscriptions]).toEqual([[], []]);
    expect(await provider.memberships.subscriptionState(row.subscriptionId!)).toMatchObject({ state: expect.stringMatching(/^(pending|active)$/) });
    expect(expectOk(await cancelMembership(world.db, { email: JANE, role: "customer" }, row.id, joinDeps)).membership.status).not.toBe("active");
    expect(await deliver()).toEqual([]);
    expect(await heldKinds()).toContain("membership_started");
  });
});

describe("a payment link paid with the button", () => {
  const studioMakes = async () =>
    expectOk(
      await createAdminBooking(
        world.db,
        owner,
        { studioIds: [world.ids.blanche], date: "2026-11-18", startMinute: h(14), durationMinutes: 120, customer: { name: "Dana Diaz", email: "dana@example.com", phone: "407-555-0133" } },
        { now: NOW, baseUrl: BASE_URL },
      ),
    );

  it("is recorded as paid and withdrawn at the processor, and the receipt email is not sent", async () => {
    const made = await studioMakes();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    const [link] = await world.db.select().from(paymentLinks);
    expect(await getPayPage(world.db, link.id, deps())).toMatchObject({ status: "open", fakePayment: true });
    await deliver(); // the link itself went to the client before the button was pressed
    expect(await fakePayLink(world.db, link.id, deps())).toBe(true);
    expect(await fakePayLink(world.db, link.id, deps())).toBe(false);
    expect((await getAppointment(world.db, owner, made.ref, NOW))!.payments).toMatchObject({ dueCents: 0 });
    expect(await paymentsOf(made.ref)).toEqual([expect.objectContaining({ providerPaymentId: `fake_link_${link.id}`, amountCents: 17600, status: "succeeded" })]);
    expect(world.links[0].state).toEqual({ state: "cancelled" });
    expect(await getPayPage(world.db, link.id, deps())).toMatchObject({ status: "paid", fakePayment: false });
    expect(await deliver()).toEqual([]);
    expect(await heldKinds()).toEqual(["payment_received"]);
  });

  it("is not offered, nor taken, with a processor that does not offer the button", async () => {
    const made = await studioMakes();
    expectOk(await sendPayLink(world.db, owner, made.ref, world.manageDeps()));
    const [link] = await world.db.select().from(paymentLinks);
    expect(await getPayPage(world.db, link.id, world.manageDeps())).toMatchObject({ status: "open", fakePayment: false });
    expect(await fakePayLink(world.db, link.id, world.manageDeps())).toBe(false);
    expect(await paymentsOf(made.ref)).toEqual([]);
  });
});

describe("where the button is offered", () => {
  const sandbox = { SQUARE_ACCESS_TOKEN: "t", SQUARE_LOCATION_ID: "l", SQUARE_APPLICATION_ID: "sandbox-sq0idb-a", NODE_ENV: "production" };

  it("is offered where no money moves: Square's sandbox and the pretend processor", () => {
    for (const env of [sandbox, { PAYMENTS_MODE: "mock", NODE_ENV: "production" }, {}]) {
      const set = resolvePayments(env);
      expect(set.client.fakePayment).toBe(true);
      expect(set.provider?.offersFakePayment).toBe(true);
    }
  });

  it("is never offered with Square's live account, or where payments are off", () => {
    for (const env of [{ ...sandbox, SQUARE_APPLICATION_ID: "sq0idp-a" }, { NODE_ENV: "production" }, { ...sandbox, SQUARE_ENVIRONMENT: "production" }]) {
      const set = resolvePayments(env);
      expect(set.client.fakePayment).toBeUndefined();
      expect(set.provider?.offersFakePayment).toBeUndefined();
    }
  });
});
