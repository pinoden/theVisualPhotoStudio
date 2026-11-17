import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookings, payments, promoCodes, refunds, settings, staffShifts } from "@/db/schema";
import { listBookings } from "./admin";
import { createAdminBooking, getAppointment } from "./appointments";
import type { AuthUser } from "./auth";
import { toBookingViews } from "./bookings";
import { cancelBooking, getManageChoices, ownerRefund, requestRescheduleCode, retryOpenRefunds } from "./manage";
import { netCardPaidCents, paidAtStudioCents } from "./money";
import { loadReceipts } from "./receipts";
import { moneyOf, recordHandRefund, recordStudioPayment, voidStudioPayment } from "./studio-payments";
import { BASE_URL, createTestWorld, expectOk, FAR, h, minutesAfter, NEAR, NOW, OWNER_EMAIL, type TestWorld } from "./testing";

/**
 * The owner's answer of 2026-11-15: a booking made in the admin gets a "mark
 * as paid" record, so that payments taken at the studio are recorded by hand.
 */
let world: TestWorld;
let owner: AuthUser;
let sam: AuthUser; // staff, assigned to NEAR
let jane: AuthUser; // a customer

beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser("owner@studio.test", "owner", "Olivia");
  sam = await world.addUser("sam@studio.test", "staff", "Sam");
  jane = await world.addUser("jane@example.com", "customer", "Jane");
  await world.db.insert(staffShifts).values({ userId: sam.id, day: NEAR });
});

const row = async (ref: string) => (await world.db.select().from(bookings).where(eq(bookings.ref, ref)))[0];
const allow = (key: string, value = true) =>
  world.db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
const cash = (amountCents: number, note = "") => ({ amountCents, method: "cash", note });
/** A booking the owner makes for Dana: Blanche, two hours, $176 to pay at the studio. */
async function madeInAdmin(date = NEAR, startMinute = h(14)) {
  const made = expectOk(
    await createAdminBooking(
      world.db,
      owner,
      {
        studioIds: [world.ids.blanche],
        date,
        startMinute,
        durationMinutes: 120,
        customer: { name: "Dana Diaz", email: "dana@example.com", phone: "407-555-0133" },
      },
      { now: NOW, baseUrl: BASE_URL },
    ),
  );
  return { ...made, id: (await row(made.ref)).id };
}

describe("a booking made in the admin", () => {
  it("owes its whole price until a payment is recorded", async () => {
    const made = await madeInAdmin();
    const booking = await row(made.ref);
    expect(await moneyOf(world.db, booking)).toEqual({ totalCents: 17600, receivedCents: 0, dueCents: 17600, ended: null, testMode: false, payments: [] });
    expect((await toBookingViews(world.db, [booking]))[0]).toMatchObject({ madeByAdmin: true, receivedCents: 0, dueCents: 17600 });
    const appointment = (await getAppointment(world.db, owner, made.ref, NOW))!;
    expect(appointment.payments).toMatchObject({ dueCents: 17600 });
    expect(appointment.may).toMatchObject({ recordPayment: true, changePayments: true });
  });

  it("is marked as paid in one payment, or in parts, and never for more than it owes", async () => {
    const made = await madeInAdmin();
    const later = minutesAfter(NOW, 5);

    // A deposit in cash, then the rest by card on the studio's reader.
    expect(await recordStudioPayment(world.db, owner, made.ref, cash(5000, "Deposit"), NOW)).toEqual({ ok: true, amountCents: 5000, dueCents: 12600 });
    expect(await recordStudioPayment(world.db, owner, made.ref, cash(12601), later)).toEqual({
      ok: false,
      reason: "too_much",
      message: "Only $126 is still to pay for this booking.",
    });
    expect(await recordStudioPayment(world.db, owner, made.ref, { amountCents: 12600, method: "card", note: "" }, later)).toEqual({
      ok: true,
      amountCents: 12600,
      dueCents: 0,
    });
    expect(await recordStudioPayment(world.db, owner, made.ref, cash(100), later)).toMatchObject({ ok: false, reason: "nothing_due" });

    const money = await moneyOf(world.db, await row(made.ref));
    expect(money).toMatchObject({ totalCents: 17600, receivedCents: 17600, dueCents: 0 });
    expect(money.payments.map((p) => [p.amountCents, p.how, p.byHand, p.recordedBy, p.note, p.voided])).toEqual([
      [5000, "Cash", true, "owner@studio.test", "Deposit", false],
      [12600, "Card, on the studio's own reader", true, "owner@studio.test", "", false],
    ]);
    expect(await paidAtStudioCents(world.db, made.id)).toBe(17600);
    // None of it is card money the site could send back.
    expect(await netCardPaidCents(world.db, made.id)).toBe(0);
    expect(world.charges).toHaveLength(0);
  });

  it("tells the client what was received and what is still to pay, and writes the history", async () => {
    const made = await madeInAdmin();
    expectOk(await recordStudioPayment(world.db, owner, made.ref, cash(5000), NOW));
    expectOk(await recordStudioPayment(world.db, owner, made.ref, { amountCents: 12600, method: "transfer", note: "" }, minutesAfter(NOW, 1)));

    const mails = await world.emails("payment_received");
    expect(mails.map((mail) => mail.toEmail)).toEqual(["dana@example.com", "dana@example.com"]);
    expect(mails[0].subject).toBe(`Payment received for booking ${made.ref}`);
    expect(mails[0].body).toContain(`We received your payment of $50 for booking ${made.ref}`);
    expect(mails[0].body).toContain("Paid at the studio: Cash");
    expect(mails[0].body).toContain("Still to pay: $126");
    expect(mails[1].body).toContain("Your booking is paid in full.");

    const { history } = (await getAppointment(world.db, owner, made.ref, NOW))!;
    expect(history.slice(1).map((event) => [event.actor, event.note])).toEqual([
      ["owner@studio.test", "Payment of $50 recorded (cash); $126 still to pay"],
      ["owner@studio.test", "Payment of $126 recorded (bank transfer or payment app); paid in full"],
    ]);
    // The lines record a payment, not a change of label.
    expect(history.slice(1).every((event) => event.from === event.to)).toBe(true);
  });

  it("refuses an amount or a method that makes no sense", async () => {
    const made = await madeInAdmin();
    expect(await recordStudioPayment(world.db, owner, made.ref, cash(0), NOW)).toMatchObject({ ok: false, reason: "bad_amount" });
    expect(await recordStudioPayment(world.db, owner, made.ref, cash(-500), NOW)).toMatchObject({ ok: false, reason: "bad_amount" });
    expect(await recordStudioPayment(world.db, owner, made.ref, cash(10.5), NOW)).toMatchObject({ ok: false, reason: "bad_amount" });
    expect(await recordStudioPayment(world.db, owner, made.ref, { amountCents: 100, method: "gold", note: "" }, NOW)).toMatchObject({
      ok: false,
      reason: "bad_method",
    });
    expect(await recordStudioPayment(world.db, owner, "VS-NOPE22", cash(100), NOW)).toMatchObject({ ok: false, reason: "not_found" });
    expect(await world.db.select().from(payments)).toHaveLength(0);
  });

  it("records the same cash once when two people record it at the same moment", async () => {
    const made = await madeInAdmin();
    const results = await Promise.all([
      recordStudioPayment(world.db, owner, made.ref, cash(17600), NOW),
      recordStudioPayment(world.db, owner, made.ref, cash(17600), NOW),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await paidAtStudioCents(world.db, made.id)).toBe(17600);
  });
});

describe("a booking made in the admin that has ended", () => {
  it("owes nothing, whatever was paid of it, wherever it is shown", async () => {
    const dana = { kind: "customer", email: "dana@example.com" } as const;
    // Part paid, then cancelled by the client.
    const partPaid = await madeInAdmin(FAR, h(9));
    expectOk(await recordStudioPayment(world.db, owner, partPaid.ref, cash(4000), NOW));
    expectOk(await cancelBooking(world.db, partPaid.ref, dana, world.manageDeps()));
    expect(await moneyOf(world.db, await row(partPaid.ref))).toMatchObject({ receivedCents: 4000, dueCents: 0, ended: "cancelled" });
    // Part paid, then released for a reschedule code.
    const released = await madeInAdmin(FAR, h(13));
    expectOk(await recordStudioPayment(world.db, owner, released.ref, cash(5000), NOW));
    expectOk(await requestRescheduleCode(world.db, released.ref, dana, world.manageDeps()));
    expect(await moneyOf(world.db, await row(released.ref))).toMatchObject({ receivedCents: 5000, dueCents: 0, ended: "released" });
    // The customer's page reads the same figures.
    const views = await toBookingViews(world.db, [await row(partPaid.ref), await row(released.ref)]);
    expect(views.map((view) => view.dueCents)).toEqual([0, 0]);
    // One that stands still owes the rest.
    const standing = await madeInAdmin();
    expectOk(await recordStudioPayment(world.db, owner, standing.ref, cash(4000), NOW));
    expect(await moneyOf(world.db, await row(standing.ref))).toMatchObject({ dueCents: 13600, ended: null });

    // Its receipt says it was paid in part, not in full; and the client, on a page opened before, is told it ended.
    const { receipts } = await loadReceipts(world.db, "dana@example.com");
    expect(receipts.find((receipt) => receipt.ref === partPaid.ref)).toMatchObject({ status: "partly_paid", paidCents: 4000, dueCents: 0 });
    expect(await cancelBooking(world.db, partPaid.ref, dana, world.manageDeps())).toMatchObject({
      ok: false,
      code: "not_confirmed",
      message: "This booking was cancelled meanwhile, so nothing more was done. Reload the page to see it as it is now.",
    });
    // A record taken back does not make it owe anything; one of a booking that stands does.
    const [cashOfEnded] = await world.db.select().from(payments).where(eq(payments.bookingId, partPaid.id));
    expect(await voidStudioPayment(world.db, owner, cashOfEnded.id, "Typed twice", NOW)).toEqual({ ok: true, owesAgain: false });
    const [cashOfStanding] = await world.db.select().from(payments).where(eq(payments.bookingId, standing.id));
    expect(await voidStudioPayment(world.db, owner, cashOfStanding.id, "Typed twice", NOW)).toEqual({ ok: true, owesAgain: true });
  });
});

describe("who may record a payment", () => {
  it("is the owners, and staff only once the owners switch it on, on the days they may see", async () => {
    const made = await madeInAdmin();
    const other = await madeInAdmin("2026-11-19");
    expect(await recordStudioPayment(world.db, sam, made.ref, cash(5000), NOW)).toMatchObject({ ok: false, reason: "forbidden" });
    expect(await recordStudioPayment(world.db, jane, made.ref, cash(5000), NOW)).toMatchObject({ ok: false, reason: "forbidden" });
    // Without the ability and without the prices, staff are shown nothing about the money.
    expect((await getAppointment(world.db, sam, made.ref, NOW))!).toMatchObject({ payments: null, money: null, may: { recordPayment: false } });

    await allow("staffRecordsPayments");
    const appointment = (await getAppointment(world.db, sam, made.ref, NOW))!;
    expect(appointment.payments).toMatchObject({ dueCents: 17600 }); // they see what is owed, to take it
    expect(appointment.money).toBeNull(); // and still not the price breakdown
    expect(appointment.may).toMatchObject({ recordPayment: true, changePayments: false });
    expect(await recordStudioPayment(world.db, sam, made.ref, cash(5000), NOW)).toMatchObject({ ok: true, dueCents: 12600 });
    expect((await moneyOf(world.db, await row(made.ref))).payments[0].recordedBy).toBe("sam@studio.test");

    // A day that is not theirs, and a booking that does not exist, get the same answer.
    expect(await recordStudioPayment(world.db, sam, other.ref, cash(5000), NOW)).toMatchObject({ ok: false, reason: "forbidden" });
    expect(await recordStudioPayment(world.db, sam, "VS-NOPE22", cash(5000), NOW)).toMatchObject({ ok: false, reason: "forbidden" });
    expect(await recordStudioPayment(world.db, jane, made.ref, cash(5000), NOW)).toMatchObject({ ok: false, reason: "forbidden" });
  });

  it("leaves taking a record back, and recording a refund, to the owners", async () => {
    const made = await madeInAdmin();
    await allow("staffRecordsPayments");
    expectOk(await recordStudioPayment(world.db, sam, made.ref, cash(5000), NOW));
    const [payment] = await world.db.select().from(payments);
    expect(await voidStudioPayment(world.db, sam, payment.id, "", NOW)).toMatchObject({ ok: false });
    expect(await recordHandRefund(world.db, sam, payment.id, { amountCents: 100, note: "" }, NOW)).toMatchObject({ ok: false });
    expect((await world.db.select().from(payments))[0]).toMatchObject({ status: "succeeded", refundedCents: 0 });
  });
});

describe("a booking that owes nothing", () => {
  it("made online is paid when it is made: there is nothing to record", async () => {
    const online = expectOk(await world.book());
    const booking = await row(online.ref);
    expect(await moneyOf(world.db, booking)).toMatchObject({ totalCents: 17600, receivedCents: 17600, dueCents: 0 });
    expect((await moneyOf(world.db, booking)).payments[0]).toMatchObject({ how: "Card, online", byHand: false, recordedBy: null });
    expect(await recordStudioPayment(world.db, owner, online.ref, cash(100), NOW)).toMatchObject({ ok: false, reason: "nothing_due" });
    expect((await getAppointment(world.db, owner, online.ref, NOW))!.may.recordPayment).toBe(false);
  });

  it("that was cancelled takes no payment", async () => {
    const made = await madeInAdmin();
    expectOk(await cancelBooking(world.db, made.ref, { kind: "owner" }, world.manageDeps()));
    expect(await recordStudioPayment(world.db, owner, made.ref, cash(100), NOW)).toMatchObject({ ok: false, reason: "not_active" });
  });
});

describe("a payment record behind a code of studio credit", () => {
  it("behind a reschedule code: not taken back while the code can be spent, nor once it paid for a booking", async () => {
    const made = await madeInAdmin(FAR);
    expectOk(await recordStudioPayment(world.db, owner, made.ref, cash(17600), NOW));
    const [payment] = await world.db.select().from(payments);
    const moved = expectOk(await requestRescheduleCode(world.db, made.ref, { kind: "customer", email: "dana@example.com" }, world.manageDeps()));
    expect(await voidStudioPayment(world.db, owner, payment.id, "", NOW)).toEqual({
      ok: false,
      message: `This booking's money went into its reschedule code ${moved.code} ($176 left). Cancel that code under Codes first, then take this record back.`,
    });
    // Cancelled by the owner, unspent: the record can go.
    await world.db.update(promoCodes).set({ voidedAt: NOW }).where(eq(promoCodes.code, moved.code));
    // Released for its code, the booking has ended: taking the record back makes it owe nothing.
    expect(await voidStudioPayment(world.db, owner, payment.id, "Recorded by mistake", NOW)).toEqual({ ok: true, owesAgain: false });
  });

  it("behind a reschedule code that paid for another booking: never taken back", async () => {
    const made = await madeInAdmin(FAR);
    expectOk(await recordStudioPayment(world.db, owner, made.ref, cash(17600), NOW));
    const [payment] = await world.db.select().from(payments);
    const moved = expectOk(await requestRescheduleCode(world.db, made.ref, { kind: "customer", email: "dana@example.com" }, world.manageDeps()));
    expectOk(await world.book({ date: FAR, startMinute: h(16), durationMinutes: 60, promoCode: moved.code, paymentToken: undefined, customer: { name: "Dana Diaz", email: "dana@example.com", phone: "407-555-0133" } }));
    await world.db.update(promoCodes).set({ voidedAt: NOW }).where(eq(promoCodes.code, moved.code));
    expect(await voidStudioPayment(world.db, owner, payment.id, "", NOW)).toEqual({
      ok: false,
      message: `This booking's money went into its reschedule code ${moved.code}, and $88 of it was spent or refunded: this record cannot be taken back.`,
    });
  });
});

describe("correcting what was recorded", () => {
  it("takes back a payment recorded by mistake: the record stays, struck out, and the booking owes it again", async () => {
    const made = await madeInAdmin();
    expectOk(await recordStudioPayment(world.db, owner, made.ref, cash(17600), NOW));
    const [payment] = await world.db.select().from(payments);

    expect(await voidStudioPayment(world.db, owner, payment.id, "Wrong booking", minutesAfter(NOW, 2))).toEqual({ ok: true, owesAgain: true });
    const money = await moneyOf(world.db, await row(made.ref));
    expect(money).toMatchObject({ receivedCents: 0, dueCents: 17600 });
    expect(money.payments).toHaveLength(1);
    expect(money.payments[0]).toMatchObject({ amountCents: 17600, voided: true });
    expect((await world.db.select().from(payments))[0]).toMatchObject({ status: "voided", error: "Taken back by owner@studio.test: Wrong booking" });
    expect((await getAppointment(world.db, owner, made.ref, NOW))!.history.at(-1)).toMatchObject({
      note: "Payment record of $176 taken back: Wrong booking",
    });

    // Once only, and the right amount can then be recorded.
    expect(await voidStudioPayment(world.db, owner, payment.id, "", NOW)).toMatchObject({ ok: false });
    expect(await voidStudioPayment(world.db, owner, "not-an-id", "", NOW)).toMatchObject({ ok: false });
    expect((await recordStudioPayment(world.db, owner, made.ref, cash(17600), minutesAfter(NOW, 3))).ok).toBe(true);
  });

  it("never takes back a card payment made through the site", async () => {
    expectOk(await world.book());
    const [payment] = await world.db.select().from(payments);
    expect(await voidStudioPayment(world.db, owner, payment.id, "", NOW)).toEqual({ ok: false, message: "That payment record was not found." });
    expect(await recordHandRefund(world.db, owner, payment.id, { amountCents: 100, note: "" }, NOW)).toMatchObject({ ok: false });
    expect((await world.db.select().from(payments))[0].status).toBe("succeeded");
  });

  it("records a refund given by hand, up to what was paid, and sends nothing to the processor", async () => {
    const made = await madeInAdmin();
    expectOk(await recordStudioPayment(world.db, owner, made.ref, cash(17600), NOW));
    const [payment] = await world.db.select().from(payments);

    expect(await recordHandRefund(world.db, owner, payment.id, { amountCents: 5000, note: "Left an hour early" }, NOW)).toEqual({ ok: true });
    expect(await recordHandRefund(world.db, owner, payment.id, { amountCents: 12601, note: "" }, NOW)).toEqual({
      ok: false,
      message: "At most $126 of that payment can still be refunded.",
    });
    expect(await recordHandRefund(world.db, owner, payment.id, { amountCents: 0, note: "" }, NOW)).toMatchObject({ ok: false });

    expect((await world.db.select().from(payments))[0]).toMatchObject({ status: "succeeded", refundedCents: 5000 });
    expect(await world.db.select().from(refunds)).toMatchObject([{ amountCents: 5000, status: "succeeded", automatic: false, reason: "Left an hour early", providerRefundId: null }]);
    expect(await paidAtStudioCents(world.db, made.id)).toBe(12600);
    // The booking is still paid in full: a refund is not a debt.
    expect((await moneyOf(world.db, await row(made.ref))).dueCents).toBe(0);

    // Nothing was sent anywhere, now or by the scheduled retry of open refunds.
    expect(await retryOpenRefunds(world.db, world.manageDeps())).toEqual({ succeeded: 0, failed: 0 });
    expect(world.refundCalls).toHaveLength(0);
    expect(await world.emails("owner_refund_notice")).toHaveLength(0);

    // What was really paid and partly given back cannot be "taken back" as a mistake.
    expect(await voidStudioPayment(world.db, owner, payment.id, "", NOW)).toMatchObject({ ok: false });
  });
});

describe("money taken at the studio and the site's own refunds", () => {
  it("is never sent back by the site: the owner's card refund has nothing to refund", async () => {
    const made = await madeInAdmin();
    expectOk(await recordStudioPayment(world.db, owner, made.ref, cash(17600), NOW));
    expect(await ownerRefund(world.db, made.ref, { amountCents: 1000, reason: "" }, world.manageDeps())).toMatchObject({
      ok: false,
      code: "bad_amount",
      message: "At most $0 can be refunded to the card for this booking.",
    });
    const [listed] = await listBookings(world.db, { from: NEAR, to: NEAR });
    expect(listed).toMatchObject({ ref: made.ref, cardHeldCents: 0, receivedCents: 17600, dueCents: 0 });
    expect(world.refundCalls).toHaveLength(0);
  });

  it("cancelled in time by the client: nothing is sent online, and the owner is asked to refund by hand", async () => {
    const made = await madeInAdmin(FAR);
    expectOk(await recordStudioPayment(world.db, owner, made.ref, cash(17600), NOW));
    const choices = await getManageChoices(world.db, made.ref, { kind: "customer", email: "dana@example.com" }, NOW);
    expect(choices?.cancel).toEqual({
      allowed: true,
      text: "Of what you paid at the studio, $167.20 is refunded ($176, less the 5% processing fee): that cannot be sent back online, so please contact the studio about it.",
    });

    const result = expectOk(await cancelBooking(world.db, made.ref, { kind: "customer", email: "dana@example.com" }, world.manageDeps()));
    expect(result).toMatchObject({ refundCents: 0, refund: "none" });
    expect(world.refundCalls).toHaveLength(0);
    expect(await world.db.select().from(refunds)).toHaveLength(0);

    const [notice] = await world.emails("owner_hand_refund");
    expect(notice.toEmail).toBe(OWNER_EMAIL);
    expect(notice.subject).toBe(`ACTION NEEDED: refund by hand for ${made.ref}`);
    expect(notice.body).toContain("Of what was paid at the studio, $176 is refunded by the rental terms, less the 5% fee: $167.20.");
  });

  it("cancelled too late, or before anything was paid: the owner has nothing to do", async () => {
    const paid = await madeInAdmin(); // four days ahead
    expectOk(await recordStudioPayment(world.db, owner, paid.ref, cash(17600), NOW));
    const late = expectOk(await cancelBooking(world.db, paid.ref, { kind: "customer", email: "dana@example.com" }, world.manageDeps()));
    expect(late.message).toBe("No refund is due, because the booking starts in less than 14 days.");

    const unpaid = await madeInAdmin(FAR);
    const none = expectOk(await cancelBooking(world.db, unpaid.ref, { kind: "customer", email: "dana@example.com" }, world.manageDeps()));
    expect(none.message).toBe("Nothing was charged to a card for this booking, so there is nothing to refund.");
    expect(await world.emails("owner_hand_refund")).toHaveLength(0);
  });

  it("moves with the booking: a reschedule code is worth what was paid at the studio", async () => {
    const made = await madeInAdmin(FAR);
    expectOk(await recordStudioPayment(world.db, owner, made.ref, cash(17600), NOW));
    const code = expectOk(await requestRescheduleCode(world.db, made.ref, { kind: "customer", email: "dana@example.com" }, world.manageDeps()));
    expect(code.valueCents).toBe(17600);
    expect((await world.db.select().from(promoCodes))[0]).toMatchObject({ kind: "amount", value: 17600, source: "reschedule", email: "dana@example.com" });
  });
});
