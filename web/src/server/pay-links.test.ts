import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BookingSummary } from "@/components/BookingSummary";
import { bookingEvents, bookings, paymentLinks, payments, promoCodes, refunds, settings, staffShifts } from "@/db/schema";
import { createAdminBooking, getAppointment } from "./appointments";
import type { AuthUser } from "./auth";
import {
  cancelBooking,
  getManageChoices,
  noticeBookingPayments,
  ownerCancelBooking,
  ownerRefund,
  requestRescheduleCode,
  retryOpenRefunds,
} from "./manage";
import { netCardPaidCents } from "./money";
import {
  cancelPayLink,
  checkBookingPayLink,
  checkOpenPayLinks,
  checkPayLink,
  closePayLinkByHand,
  getPayPage,
  noticePaidLinksOf,
  openPayLinkOf,
  pretendToPay,
  sendPayLink,
  withinSeconds,
  type PayLinkDeps,
} from "./pay-links";
import type { PaymentProvider } from "./payments";
import { moneyOf, recordStudioPayment, voidStudioPayment } from "./studio-payments";
import { runScheduledTasks } from "./tasks";
import { BASE_URL, createTestWorld, expectOk, FAR, h, minutesAfter, NEAR, NOW, type TestWorld } from "./testing";

/**
 * The owner's answer of 2026-11-15: for a booking made in the admin, "add an
 * option to send them a payment link to Square". The processor in these tests
 * has a payment page of its own, as Square has, and a test says when a link
 * was paid there. What Square really answers is in payments.test.ts.
 */
let world: TestWorld;
let owner: AuthUser;
let sam: AuthUser; // staff, assigned to NEAR
let square: PaymentProvider; // the test processor under Square's name

beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser("owner@studio.test", "owner", "Olivia");
  sam = await world.addUser("sam@studio.test", "staff", "Sam");
  await world.db.insert(staffShifts).values({ userId: sam.id, day: NEAR });
  square = { ...world.provider, name: "square" };
});

const deps = (now = NOW): PayLinkDeps => ({ now, baseUrl: BASE_URL, payments: square });
const row = async (ref: string) => (await world.db.select().from(bookings).where(eq(bookings.ref, ref)))[0];
const links = () => world.db.select().from(paymentLinks);
const allow = (key: string, value = true) =>
  world.db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
const dana = { kind: "customer", email: "dana@example.com" } as const;
/** The client pays the link on the processor's page. */
const clientPays = (index = 0, amountCents?: number) => {
  const link = world.links[index];
  link.state = { state: "paid", paymentId: `mock_pay_${link.linkId}`, amountCents: amountCents ?? link.request.amountCents };
};
/**
 * A booking the owner makes for Dana: Blanche, two hours, $176 to pay at the studio. Made with Square's live account
 * set up, as the links of these tests are; `processor` says otherwise for a booking of test mode, whose link the
 * pretend processor makes (a link is of the same kind of money as its booking).
 */
async function madeInAdmin(date = NEAR, startMinute = h(14), processor = "square") {
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
      { now: NOW, baseUrl: BASE_URL, processor },
    ),
  );
  return { ...made, id: (await row(made.ref)).id };
}

describe("emailing a payment link", () => {
  it("makes a link at the processor for exactly what is owed, and emails the client a page of this site", async () => {
    const made = await madeInAdmin();
    expect(await sendPayLink(world.db, owner, made.ref, deps())).toEqual({ ok: true, amountCents: 17600, again: false });

    const [link] = await links();
    expect(link).toMatchObject({
      bookingId: made.id,
      provider: "square",
      providerLinkId: "link_1",
      providerOrderId: "order_1",
      url: "https://pay.test/link_1",
      amountCents: 17600,
      status: "open",
      createdBy: "owner@studio.test",
    });
    // What the processor was asked for: the amount, a title the client can recognise, and the way back.
    expect(world.links[0].request).toEqual({
      amountCents: 17600,
      idempotencyKey: link.id,
      title: `Booking ${made.ref}: Studio Blanche, Wed, Nov 18, 2026, 2:00 PM`,
      note: `${made.ref} Dana Diaz`,
      returnUrl: `${BASE_URL}/pay/${link.id}`,
    });

    const [mail] = await world.emails("payment_link");
    expect(mail).toMatchObject({ toEmail: "dana@example.com", subject: `Pay for your booking ${made.ref}` });
    expect(mail.body).toContain(`${BASE_URL}/pay/${link.id}`);
    expect(mail.body).toContain("Amount: $176");
    // The client is sent to this site's page, never straight to an address at the processor.
    expect(mail.body).not.toContain("pay.test");

    const appointment = (await getAppointment(world.db, owner, made.ref, NOW))!;
    expect(appointment.payLink).toMatchObject({ id: link.id, amountCents: 17600, status: "open", createdBy: "owner@studio.test" });
    expect(appointment.history.at(-1)).toMatchObject({ actor: "owner@studio.test", note: "Payment link for $176 emailed to the client" });
  });

  it("emails the same link again when asked again: one booking has one open link", async () => {
    const made = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    expect(await sendPayLink(world.db, owner, made.ref, deps(minutesAfter(NOW, 5)))).toEqual({ ok: true, amountCents: 17600, again: true });
    expect(await links()).toHaveLength(1);
    expect(world.links).toHaveLength(1);
    const mails = await world.emails("payment_link");
    expect(mails).toHaveLength(2);
    expect(mails[1].body).toContain(`/pay/${(await links())[0].id}`);
  });

  it("makes one link when two people press the button at the same moment", async () => {
    const made = await madeInAdmin();
    const results = await Promise.all([sendPayLink(world.db, owner, made.ref, deps()), sendPayLink(world.db, owner, made.ref, deps())]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect((await links()).filter((link) => link.status === "open")).toHaveLength(1);
    // The link that lost was withdrawn at the processor, so it cannot be paid by anyone.
    const kept = (await links())[0].providerLinkId;
    expect(world.links.filter((link) => link.linkId !== kept).every((link) => link.state.state === "cancelled")).toBe(true);
  });

  it("is for the part still owed when a part was paid at the studio", async () => {
    const made = await madeInAdmin();
    expectOk(await recordStudioPayment(world.db, owner, made.ref, { amountCents: 5000, method: "cash", note: "Deposit" }, NOW));
    expect(await sendPayLink(world.db, owner, made.ref, deps())).toMatchObject({ ok: true, amountCents: 12600 });
    expect(world.links[0].request.amountCents).toBe(12600);
  });

  it("is refused when nothing is owed, for a cancelled booking, and without a card processor", async () => {
    const online = expectOk(await world.book({}, { payments: square }));
    expect(await sendPayLink(world.db, owner, online.ref, deps())).toMatchObject({ ok: false, reason: "nothing_due" });

    const made = await madeInAdmin();
    expect(await sendPayLink(world.db, owner, made.ref, { ...deps(), payments: null })).toEqual({
      ok: false,
      reason: "no_processor",
      message: "Card payments are not set up, so no payment link can be made.",
    });
    world.failLinks = "INVALID_REQUEST_ERROR";
    expect(await sendPayLink(world.db, owner, made.ref, deps())).toEqual({
      ok: false,
      reason: "processor_refused",
      message: "The payment link could not be made: INVALID_REQUEST_ERROR",
    });
    world.failLinks = null;

    expectOk(await cancelBooking(world.db, made.ref, { kind: "owner" }, world.manageDeps()));
    expect(await sendPayLink(world.db, owner, made.ref, deps())).toMatchObject({ ok: false, reason: "not_active" });
    expect(await sendPayLink(world.db, owner, "VS-NOPE22", deps())).toMatchObject({ ok: false, reason: "not_found" });
    expect(await links()).toHaveLength(0);
    expect(await world.emails("payment_link")).toHaveLength(0);
  });

  it("is the owners' to send, and staff's once the owners let them record payments, on their days", async () => {
    const made = await madeInAdmin();
    const other = await madeInAdmin("2026-11-19");
    expect(await sendPayLink(world.db, sam, made.ref, deps())).toMatchObject({ ok: false, reason: "forbidden" });
    await allow("staffRecordsPayments");
    expect(await sendPayLink(world.db, sam, made.ref, deps())).toMatchObject({ ok: true });
    expect((await links())[0].createdBy).toBe("sam@studio.test");
    expect(await sendPayLink(world.db, sam, other.ref, deps())).toMatchObject({ ok: false, reason: "forbidden" });
    expect(await sendPayLink(world.db, sam, "VS-NOPE22", deps())).toMatchObject({ ok: false, reason: "forbidden" });
    expect(await checkBookingPayLink(world.db, sam, other.ref, deps())).toMatchObject({ ok: false });
    expect(await cancelPayLink(world.db, sam, other.ref, deps())).toMatchObject({ ok: false });
  });
});

describe("when the client pays the link", () => {
  it("becomes a card payment on the booking, which is then paid in full", async () => {
    const made = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    const [link] = await links();

    // Not paid yet: asking changes nothing.
    expect(await checkPayLink(world.db, link.id, deps())).toBe("open");
    expect(await world.db.select().from(payments)).toHaveLength(0);

    clientPays();
    const paidAt = minutesAfter(NOW, 30);
    expect(await checkPayLink(world.db, link.id, deps(paidAt))).toBe("paid");

    const [payment] = await world.db.select().from(payments);
    expect(payment).toMatchObject({ bookingId: made.id, provider: "square", providerPaymentId: "mock_pay_link_1", amountCents: 17600, status: "succeeded" });
    expect((await links())[0]).toMatchObject({ status: "paid", paidAt, paymentId: payment.id });

    const money = await moneyOf(world.db, await row(made.ref));
    expect(money).toMatchObject({ receivedCents: 17600, dueCents: 0 });
    expect(money.payments[0]).toMatchObject({ how: "Card, through the payment link", byHand: false });
    // The client's booking page and the appointment say how it was paid: by card, not at the studio.
    const summary = renderToStaticMarkup(createElement(BookingSummary, { booking: (await getAppointment(world.db, owner, made.ref, paidAt))!.money! }));
    expect(summary).toContain("<span>Paid by card</span>");
    expect(summary).not.toContain("at the studio");
    // It is card money, held by the processor: the site can send it back like any other card payment.
    expect(await netCardPaidCents(world.db, made.id)).toBe(17600);

    const [mail] = await world.emails("payment_received");
    expect(mail.toEmail).toBe("dana@example.com");
    expect(mail.body).toContain("We received your payment of $176");
    expect(mail.body).toContain("Paid by: Card, through the payment link");
    expect(mail.body).toContain("Your booking is paid in full.");

    const appointment = (await getAppointment(world.db, owner, made.ref, paidAt))!;
    expect(appointment.payLink).toBeNull();
    expect(appointment.history.at(-1)).toMatchObject({ actor: "customer", note: "Payment of $176 received through the payment link; paid in full" });
  });

  it("is recorded once, however often and from wherever the processor is asked", async () => {
    const made = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    const [link] = await links();
    clientPays();
    const answers = await Promise.all([
      checkPayLink(world.db, link.id, deps()),
      checkPayLink(world.db, link.id, deps()),
      getPayPage(world.db, link.id, deps()),
      checkBookingPayLink(world.db, owner, made.ref, deps()),
    ]);
    expect(answers[0]).toBe("paid");
    expect(answers[1]).toBe("paid");
    expect(await checkPayLink(world.db, link.id, deps())).toBe("paid");
    expect(await world.db.select().from(payments)).toHaveLength(1);
    expect(await world.emails("payment_received")).toHaveLength(1);
  });

  it("is noticed by the scheduled task, with nobody looking", async () => {
    const made = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    const run = () => runScheduledTasks(world.db, { ...world.manageDeps({ payments: square }), email: null });
    expect(await run()).toMatchObject({ payLinksPaid: 0, payLinksClosed: 0 });
    clientPays();
    expect(await run()).toMatchObject({ payLinksPaid: 1, payLinksClosed: 0 });
    expect(await run()).toMatchObject({ payLinksPaid: 0 });
    expect((await moneyOf(world.db, await row(made.ref))).dueCents).toBe(0);
  });

  it("records what the processor says was paid, and leaves the link open while the processor cannot be asked", async () => {
    const made = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    const [link] = await links();
    world.links[0].state = { state: "unknown", message: "No answer from Square" };
    // Asked, and it could not say: the link may have been paid, and stays open.
    expect(await checkPayLink(world.db, link.id, deps())).toBe("unanswered");
    expect((await links())[0].status).toBe("open");
    // No processor at all, or a different one from the link's own: it can never be asked, and the link stays open.
    expect(await checkPayLink(world.db, link.id, { ...deps(), payments: null })).toBe("foreign");
    expect(await checkPayLink(world.db, link.id, { ...deps(), payments: world.provider })).toBe("foreign");
    expect((await links())[0].status).toBe("open");
    expect(await checkPayLink(world.db, "not-a-link", deps())).toBe("unknown");
    expect(await world.db.select().from(payments)).toHaveLength(0);

    clientPays(0, 17600);
    expect(await checkPayLink(world.db, link.id, deps())).toBe("paid");
    expect((await world.db.select().from(payments))[0].amountCents).toBe(17600);
  });

  it("is refunded through the processor like any card payment when the client cancels in time", async () => {
    const made = await madeInAdmin(FAR);
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    clientPays();
    expect(await checkPayLink(world.db, (await links())[0].id, deps())).toBe("paid");

    const result = expectOk(await cancelBooking(world.db, made.ref, dana, world.manageDeps({ payments: square })));
    expect(result).toMatchObject({ refundCents: 17600 - 880, feeCents: 880, refund: "sent" });
    expect(world.refundCalls.at(-1)).toMatchObject({ paymentId: "mock_pay_link_1", amountCents: 16720 });
  });
});

describe("a link and money taken at the studio", () => {
  it("cannot both be open: cash is recorded only once the link is cancelled", async () => {
    const made = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    expect(await recordStudioPayment(world.db, owner, made.ref, { amountCents: 17600, method: "cash", note: "" }, NOW)).toEqual({
      ok: false,
      reason: "link_open",
      message: "A payment link for $176 is open for this booking. Cancel the link before recording a payment by hand, so that the client cannot pay twice.",
    });

    expect(await cancelPayLink(world.db, owner, made.ref, deps())).toEqual({ ok: true, outcome: "cancelled" });
    expect(world.links[0].state).toEqual({ state: "cancelled" }); // withdrawn at the processor: it can no longer be paid
    expect((await links())[0]).toMatchObject({ status: "cancelled", cancelledAt: NOW });
    expect(await openPayLinkOf(world.db, made.id)).toBeNull();
    expect((await getAppointment(world.db, owner, made.ref, NOW))!.history.at(-1)).toMatchObject({ note: "Payment link for $176 cancelled" });

    expect((await recordStudioPayment(world.db, owner, made.ref, { amountCents: 17600, method: "cash", note: "" }, NOW)).ok).toBe(true);
    expect(await cancelPayLink(world.db, owner, made.ref, deps())).toEqual({ ok: false, message: "This booking has no open payment link." });
  });

  it("records the payment instead of cancelling when the client paid in the meantime", async () => {
    const made = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    clientPays();
    expect(await cancelPayLink(world.db, owner, made.ref, deps())).toEqual({ ok: true, outcome: "was_paid" });
    expect((await links())[0].status).toBe("paid");
    expect((await moneyOf(world.db, await row(made.ref))).dueCents).toBe(0);
  });

  it("stays open when the processor cannot withdraw it: a link is never called cancelled while it can still be paid", async () => {
    const made = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    world.failLinks = "Could not reach the payment processor.";
    expect(await cancelPayLink(world.db, owner, made.ref, deps())).toEqual({
      ok: false,
      message: "The link could not be cancelled: Could not reach the payment processor.",
    });
    expect((await links())[0].status).toBe("open");
  });

  it("is not sent again for a different amount while the first is open", async () => {
    const made = await madeInAdmin();
    expectOk(await recordStudioPayment(world.db, owner, made.ref, { amountCents: 5000, method: "cash", note: "" }, NOW));
    expectOk(await sendPayLink(world.db, owner, made.ref, deps())); // for the $126 still owed
    // The $50 turns out to have been recorded by mistake: the booking owes $176 again.
    const [cash] = await world.db.select().from(payments);
    expect(await voidStudioPayment(world.db, owner, cash.id, "Wrong booking", NOW)).toEqual({ ok: true, owesAgain: true });
    expect(await sendPayLink(world.db, owner, made.ref, deps())).toEqual({
      ok: false,
      reason: "other_amount_open",
      message: "A payment link for $126 is still open, and the booking now owes $176. Cancel that link first.",
    });
    expectOk(await cancelPayLink(world.db, owner, made.ref, deps()));
    expect(await sendPayLink(world.db, owner, made.ref, deps())).toMatchObject({ ok: true, amountCents: 17600, again: false });
  });
});

describe("a booking that stops being active", () => {
  it("has its open link withdrawn when the client cancels, takes a reschedule code, or the studio cancels", async () => {
    const withLink = async (date: string, startMinute: number) => {
      const made = await madeInAdmin(date, startMinute);
      expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
      return made;
    };
    const manage = world.manageDeps({ payments: square });

    const first = await withLink(NEAR, h(9));
    expectOk(await cancelBooking(world.db, first.ref, dana, manage));
    const second = await withLink(NEAR, h(12));
    expectOk(await ownerCancelBooking(world.db, second.ref, { refundCents: 0 }, manage));
    // A reschedule code needs something paid: half in cash, and a link for the rest.
    const third = await madeInAdmin(FAR, h(9));
    expectOk(await recordStudioPayment(world.db, owner, third.ref, { amountCents: 8800, method: "cash", note: "" }, NOW));
    expectOk(await sendPayLink(world.db, owner, third.ref, deps()));
    expectOk(await requestRescheduleCode(world.db, third.ref, dana, manage));

    expect((await links()).map((link) => link.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(world.links.map((link) => link.state.state)).toEqual(["cancelled", "cancelled", "cancelled"]);
  });

  it("is caught by the scheduled task when the link could not be withdrawn at the time", async () => {
    const made = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    // The processor is down while the booking is cancelled: the cancellation goes through all the same.
    world.failLinks = "Could not reach the payment processor.";
    expectOk(await cancelBooking(world.db, made.ref, dana, world.manageDeps({ payments: square })));
    expect((await links())[0].status).toBe("open");

    world.failLinks = null;
    expect(await checkOpenPayLinks(world.db, deps())).toEqual({ paid: 0, closed: 1 });
    expect((await links())[0].status).toBe("cancelled");
    expect(await checkOpenPayLinks(world.db, deps())).toEqual({ paid: 0, closed: 0 });
  });

  it("counts a payment the client made just before cancelling: the terms of the cancellation apply to it", async () => {
    const made = await madeInAdmin(); // four days ahead: inside the refund window
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    clientPays();
    // Paid on the processor's page, not seen yet: the cancellation asks first, and counts it.
    const cancelled = expectOk(await cancelBooking(world.db, made.ref, dana, world.manageDeps({ payments: square })));
    expect(cancelled.message).toBe("No refund is due, because the booking starts in less than 14 days.");
    expect((await links())[0].status).toBe("paid");
    expect(await world.db.select().from(refunds)).toEqual([]);
    expect(await netCardPaidCents(world.db, made.id)).toBe(17600);
    expect(await world.emails("late_payment_refunded")).toHaveLength(0);
  });

  it("counts a payment the client made just before releasing the booking: the code holds it", async () => {
    const made = await madeInAdmin(FAR, h(9));
    expectOk(await recordStudioPayment(world.db, owner, made.ref, { amountCents: 7600, method: "cash", note: "" }, NOW));
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    clientPays();
    const moved = expectOk(await requestRescheduleCode(world.db, made.ref, dana, world.manageDeps({ payments: square })));
    expect(moved.valueCents).toBe(17600);
    expect(await world.db.select().from(refunds)).toEqual([]);
  });

  it("gives back in full a payment made after the booking ended, says so, and puts the email right when the refund fails", async () => {
    const made = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    // The processor is down while the booking is cancelled: the link stays open, and the client pays it afterwards.
    world.failLinks = "Could not reach the payment processor.";
    expectOk(await cancelBooking(world.db, made.ref, dana, world.manageDeps({ payments: square })));
    world.failLinks = null;
    clientPays();
    world.failRefunds = "The card account is closed";
    expect(await checkOpenPayLinks(world.db, { ...deps(), ownerEmail: "owner@studio.test" })).toEqual({ paid: 1, closed: 0 });
    expect(await world.db.select().from(refunds)).toMatchObject([{ amountCents: 17600, automatic: true, status: "failed", reason: `Paid after ${made.ref} was cancelled` }]);
    const [late] = await world.emails("late_payment_refunded");
    expect(late.subject).toBe(`Your payment for booking ${made.ref} is due back to your card`);
    expect(late.body).toContain(
      `Your payment of $176 through the payment link for booking ${made.ref} was recorded after the booking was cancelled, so it is due back to your card in full. It has not reached your card yet`,
    );
    // The page the client is sent back to says it has not reached the card yet.
    const [link] = await links();
    expect(await getPayPage(world.db, link.id, deps())).toMatchObject({ status: "refunded", late: { released: false, made: false } });
    // Tried again by the scheduled task, it goes through; the money comes back once.
    world.failRefunds = null;
    expect(await retryOpenRefunds(world.db, world.manageDeps({ payments: square }))).toEqual({ succeeded: 1, failed: 0 });
    expect(await netCardPaidCents(world.db, made.id)).toBe(0);
    // And then that it is refunded.
    expect(await getPayPage(world.db, link.id, deps())).toMatchObject({ status: "refunded", late: { released: false, made: true } });
  });

  it("tells the administrator who checks whether a late payment's refund went through", async () => {
    const made = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    world.failLinks = "Could not reach the payment processor.";
    expectOk(await cancelBooking(world.db, made.ref, dana, world.manageDeps({ payments: square })));
    world.failLinks = null;
    clientPays();
    world.failRefunds = "The card account is closed";
    expect(await checkBookingPayLink(world.db, owner, made.ref, { ...deps(), ownerEmail: "owner@studio.test" })).toEqual({
      ok: true,
      status: "paid",
      late: { made: false },
    });
  });

  it("is still a payment received on its page when a cancellation refunded part of it", async () => {
    // Paid while the booking stood, then the studio cancelled it and refunded $50: the payment counted, and the
    // cancellation's email tells the refund. The page does not say it was refunded in full.
    const made = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    clientPays();
    const [link] = await links();
    expect(await getPayPage(world.db, link.id, deps())).toMatchObject({ status: "paid" });
    expectOk(await ownerCancelBooking(world.db, made.ref, { refundCents: 5000 }, world.manageDeps({ payments: square })));
    expect(await getPayPage(world.db, link.id, deps())).toMatchObject({ status: "paid", late: null });

    // Released for a reschedule code, and a refund taken off the code: the same.
    const other = await madeInAdmin(FAR, h(9));
    expectOk(await sendPayLink(world.db, owner, other.ref, deps()));
    clientPays(1);
    expectOk(await requestRescheduleCode(world.db, other.ref, dana, world.manageDeps({ payments: square })));
    expectOk(await ownerRefund(world.db, other.ref, { amountCents: 2000, reason: "" }, world.manageDeps({ payments: square })));
    const second = (await links()).find((candidate) => candidate.bookingId === other.id)!;
    expect(await getPayPage(world.db, second.id, deps())).toMatchObject({ status: "paid", late: null });
  });

  it("is not withdrawn while the processor cannot say whether it was paid, so that no payment is lost with it", async () => {
    const made = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    const [link] = await links();
    world.links[0].state = { state: "unknown", message: "The payment behind the link could not be read" };

    expect(await cancelPayLink(world.db, owner, made.ref, deps())).toEqual({
      ok: false,
      message:
        "The card processor could not say whether the link was paid, so it was not withdrawn. Try again in a moment. If it goes on, look the link up in Square: an owner can then close it here by hand.",
    });
    expect(await checkBookingPayLink(world.db, owner, made.ref, deps())).toEqual({
      ok: false,
      message:
        "The card processor could not say whether the link was paid. Try again in a moment. If it goes on, look the link up in Square: an owner can then close it here by hand.",
    });
    // The studio cancels the booking all the same, and its link stays open, to be asked about again.
    expectOk(await ownerCancelBooking(world.db, made.ref, { refundCents: 0 }, world.manageDeps({ payments: square })));
    expect((await links())[0].status).toBe("open");
    expect(world.links[0].state.state).toBe("unknown");
    expect(await checkOpenPayLinks(world.db, deps())).toEqual({ paid: 0, closed: 0 });

    // It was paid after all: once the processor can say so, the payment is recorded, and given back in full.
    clientPays();
    expect(await checkOpenPayLinks(world.db, { ...deps(), ownerEmail: "owner@studio.test" })).toEqual({ paid: 1, closed: 0 });
    expect(await getPayPage(world.db, link.id, deps())).toMatchObject({ status: "refunded", late: { released: false, made: true } });
    expect(await netCardPaidCents(world.db, made.id)).toBe(0);
  });

  it("says a booking released for a reschedule code when a payment comes after it", async () => {
    const made = await madeInAdmin(FAR, h(9));
    expectOk(await recordStudioPayment(world.db, owner, made.ref, { amountCents: 7600, method: "cash", note: "" }, NOW));
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    world.failLinks = "Could not reach the payment processor.";
    const moved = expectOk(await requestRescheduleCode(world.db, made.ref, dana, world.manageDeps({ payments: square })));
    world.failLinks = null;
    clientPays();
    expect(await checkOpenPayLinks(world.db, deps())).toEqual({ paid: 1, closed: 0 });
    expect(await world.db.select().from(refunds)).toMatchObject([{ amountCents: 10000, status: "succeeded", reason: `Paid after ${made.ref} was released for a reschedule code` }]);
    expect((await world.emails("late_payment_refunded"))[0].body).toContain("was recorded after the booking was released for a reschedule code, so it is refunded to your card in full.");
    expect((await world.db.select().from(promoCodes).where(eq(promoCodes.code, moved.code)))[0].value).toBe(7600);
  });
});

describe("what a client is told before cancelling or moving", () => {
  it("counts a payment made on the processor's page that the site has not seen yet", async () => {
    const made = await madeInAdmin(); // four days ahead: inside the refund window
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    clientPays();
    // The booking's page asks the processor before it says what cancelling would do.
    await noticeBookingPayments(world.db, made.ref, dana, deps());
    expect((await getManageChoices(world.db, made.ref, dana, NOW))!.cancel.text).toBe("No refund is due, because the booking starts in less than 14 days.");
    expect(await netCardPaidCents(world.db, made.id)).toBe(17600);
    // Nobody else's link is asked about from a booking's page.
    const other = await madeInAdmin(FAR, h(9));
    expectOk(await sendPayLink(world.db, owner, other.ref, deps()));
    clientPays(1);
    await noticeBookingPayments(world.db, other.ref, { kind: "customer", email: "someone@example.com" }, deps());
    expect((await links()).find((link) => link.bookingId === other.id)!.status).toBe("open");
  });

  it("hands its work on, to be finished after the page is sent, with the mail it queues", async () => {
    const made = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    clientPays();
    const handed: Promise<unknown>[] = [];
    await noticeBookingPayments(world.db, made.ref, dana, deps(), (work) => handed.push(work));
    await noticePaidLinksOf(world.db, dana.email, deps(), (work) => handed.push(work));
    expect(handed).toHaveLength(2);
    await Promise.all(handed);
    expect((await links())[0].status).toBe("paid");
  });

  it("does so for every booking on the client's account", async () => {
    const first = await madeInAdmin();
    const second = await madeInAdmin(FAR, h(9));
    expectOk(await sendPayLink(world.db, owner, first.ref, deps()));
    expectOk(await sendPayLink(world.db, owner, second.ref, deps()));
    clientPays(0);
    clientPays(1);
    await noticePaidLinksOf(world.db, "Dana@Example.com", deps());
    expect((await links()).map((link) => link.status)).toEqual(["paid", "paid"]);
  });

  it("refuses a cancellation or a move that would now do something other than what the client was shown", async () => {
    const made = await madeInAdmin(FAR, h(9)); // outside the refund window
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    const shown = (await getManageChoices(world.db, made.ref, dana, NOW))!;
    // Nothing was paid when the page was drawn. The client then pays the link in another window.
    clientPays();
    const manage = world.manageDeps({ payments: square });
    expect(await cancelBooking(world.db, made.ref, dana, manage, shown.cancel.text)).toMatchObject({ ok: false, status: 409, code: "changed" });
    expect(await requestRescheduleCode(world.db, made.ref, dana, manage, shown.reschedule.text)).toMatchObject({ ok: false, status: 409, code: "changed" });
    expect((await row(made.ref)).status).toBe("confirmed");
    expect(await world.db.select().from(refunds)).toEqual([]);
    // Shown again as it is now, the cancellation goes through, and refunds what was paid under its terms.
    const now = (await getManageChoices(world.db, made.ref, dana, NOW))!;
    expect(now.cancel.text).not.toBe(shown.cancel.text);
    expect(expectOk(await cancelBooking(world.db, made.ref, dana, manage, now.cancel.text))).toMatchObject({ refundCents: 16720 });
  });
});

describe("when the processor cannot say whether a link was paid", () => {
  const unseen =
    "We could not check just now whether the payment link for this booking was paid. If it was, that payment is refunded to your card in full once the card processor tells us.";
  const silent = () => {
    world.links[0].state = { state: "unknown", message: "Square answered HTTP 404" };
  };

  it("the client's cancellation goes ahead, says so, and a payment seen later is refunded in full", async () => {
    const made = await madeInAdmin(); // four days ahead: inside the refund window
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    silent();
    // The processor is asked once: not again to withdraw the link, which would only keep the client waiting.
    let asked = 0;
    const counting: PaymentProvider = { ...square, payLinkState: (link) => (asked++, square.payLinkState(link)) };
    const manage = world.manageDeps({ payments: counting });
    const cancelled = expectOk(await cancelBooking(world.db, made.ref, dana, manage));
    expect(asked).toBe(1);
    expect(cancelled.message).toBe(`Nothing was charged to a card for this booking, so there is nothing to refund. ${unseen}`);
    expect((await row(made.ref)).status).toBe("cancelled");
    expect((await world.emails("booking_cancelled"))[0].body).toContain(unseen);
    // The owners are told to look in Square, and the history says what happened.
    const [notice] = await world.emails("owner_unseen_link");
    expect(notice).toMatchObject({ toEmail: "owner@studio.test", subject: `CHECK THE PAYMENT LINK of ${made.ref}` });
    expect(notice.body).toContain("was cancelled while the card processor could not say whether its payment link for $176 had been paid.");
    expect(notice.body).toContain(
      'When Square shows it was paid, the site will never see that payment: refund it to the client in Square, as they were promised, then close it on the appointment\'s page with "Close it by hand".',
    );
    const notes = (await world.db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, made.id))).map((event) => event.note);
    expect(notes).toContain("The card processor could not say whether the payment link for $176 was paid: a payment through it is refunded in full once it is seen");
    // The link stays open, and is asked about again: paid after all, the payment is refunded in full.
    expect((await links())[0].status).toBe("open");
    clientPays();
    expect(await checkOpenPayLinks(world.db, { ...deps(), ownerEmail: "owner@studio.test" })).toEqual({ paid: 1, closed: 0 });
    expect(await netCardPaidCents(world.db, made.id)).toBe(0);
  });

  it("says so when a move is refused because nothing was paid that the site knows of", async () => {
    const made = await madeInAdmin(FAR, h(9));
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    silent();
    expect(await requestRescheduleCode(world.db, made.ref, dana, world.manageDeps({ payments: square }))).toMatchObject({
      ok: false,
      code: "nothing_paid",
      message:
        "Nothing was paid for this booking, so there is no credit to move. You can cancel it and book again. We could not check just now whether the payment link for this booking was paid. If you paid it, please try again later, or call us.",
    });
  });

  it("is found cancelled when an owner deleted it in Square, and closing it by hand then says so", async () => {
    const made = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    world.links[0].state = { state: "cancelled" };
    expect(await closePayLinkByHand(world.db, owner, made.ref, deps())).toEqual({ ok: true, outcome: "cancelled" });
    expect((await links())[0].status).toBe("cancelled");
    const notes = (await world.db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, made.id))).map((event) => event.note);
    expect(notes).toContain("Payment link for $176 found cancelled at the card processor");
  });

  it("counts a link of another processor as asked about, so that the scheduled task moves on", async () => {
    const test = { ...deps(), payments: world.provider };
    const made = await madeInAdmin(NEAR, h(14), "mock");
    expectOk(await sendPayLink(world.db, owner, made.ref, test));
    expect(await checkOpenPayLinks(world.db, deps(minutesAfter(NOW, 1)))).toEqual({ paid: 0, closed: 0 });
    expect((await links())[0]).toMatchObject({ status: "open", checkedAt: minutesAfter(NOW, 1) });
  });

  it("the client's move goes ahead and says so, in the answer and in the code's email", async () => {
    const made = await madeInAdmin(FAR, h(9));
    expectOk(await recordStudioPayment(world.db, owner, made.ref, { amountCents: 7600, method: "cash", note: "" }, NOW));
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    silent();
    const moved = expectOk(await requestRescheduleCode(world.db, made.ref, dana, world.manageDeps({ payments: square })));
    expect(moved).toMatchObject({ valueCents: 7600, unseenLink: true });
    expect((await world.emails("reschedule_code"))[0].body).toContain(unseen);
    expect((await world.emails("owner_unseen_link"))[0].body).toContain("was released for a reschedule code while the card processor could not say");
  });

  it("the studio's cancellation goes ahead, the owner is told, and the link stays open, to be asked about again", async () => {
    const made = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    silent();
    expect(await ownerCancelBooking(world.db, made.ref, { refundCents: 0 }, world.manageDeps({ payments: square }))).toMatchObject({
      ok: true,
      unseenLink: "unseen",
    });
    expect((await row(made.ref)).status).toBe("cancelled");
    expect((await links())[0].status).toBe("open");
    expect((await world.emails("booking_cancelled"))[0].body).toContain(unseen);
  });

  it("says nothing of a link when the processor answered", async () => {
    const made = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    const cancelled = expectOk(await cancelBooking(world.db, made.ref, dana, world.manageDeps({ payments: square })));
    expect(cancelled.message).not.toContain("could not check");
    expect(await world.emails("owner_unseen_link")).toEqual([]);
  });

  it("can be closed by hand by an owner once looked up in Square, and only then", async () => {
    const made = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    silent();
    // A manager may record payments, but closing a link without the processor's word is the owners'.
    const manager = await world.addUser("max@studio.test", "manager", "Max");
    expect(await closePayLinkByHand(world.db, manager, made.ref, deps())).toEqual({ ok: false, message: "Booking not found." });
    expect(await closePayLinkByHand(world.db, owner, made.ref, deps())).toEqual({ ok: true, outcome: "cancelled" });
    expect((await links())[0].status).toBe("cancelled");
    const notes = (await world.db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, made.id))).map((event) => event.note);
    expect(notes).toContain(
      "Payment link for $176 closed by hand: the card processor could not say whether it was paid, and the owner looked it up at the processor",
    );
    // Money taken at the studio can be recorded now.
    expectOk(await recordStudioPayment(world.db, owner, made.ref, { amountCents: 17600, method: "cash", note: "" }, NOW));
  });

  it("is withdrawn the usual way, or recorded as paid, when the processor can answer after all", async () => {
    const first = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, first.ref, deps()));
    expect(await closePayLinkByHand(world.db, owner, first.ref, deps())).toEqual({ ok: true, outcome: "cancelled" });
    expect(world.links[0].state.state).toBe("cancelled");
    const second = await madeInAdmin(FAR, h(9));
    expectOk(await sendPayLink(world.db, owner, second.ref, deps()));
    clientPays(1);
    expect(await closePayLinkByHand(world.db, owner, second.ref, deps())).toEqual({ ok: true, outcome: "was_paid" });
    expect(await netCardPaidCents(world.db, second.id)).toBe(17600);
  });

  it("does not keep the scheduled task from the other links: the longest unasked is asked first", async () => {
    // Two links the processor no longer knows, and a newer one that was paid; one link is asked about per run.
    const made = [await madeInAdmin(NEAR, h(9)), await madeInAdmin(NEAR, h(12)), await madeInAdmin(FAR, h(9))];
    for (const [index, booking] of made.entries()) expectOk(await sendPayLink(world.db, owner, booking.ref, deps(minutesAfter(NOW, index - 10))));
    world.links[0].state = { state: "unknown", message: "Square answered HTTP 404" };
    world.links[1].state = { state: "unknown", message: "Square answered HTTP 404" };
    clientPays(2);
    expect(await checkOpenPayLinks(world.db, deps(minutesAfter(NOW, 1)), 1)).toEqual({ paid: 0, closed: 0 });
    expect(await checkOpenPayLinks(world.db, deps(minutesAfter(NOW, 2)), 1)).toEqual({ paid: 0, closed: 0 });
    expect(await checkOpenPayLinks(world.db, deps(minutesAfter(NOW, 3)), 1)).toEqual({ paid: 1, closed: 0 });
    expect(await netCardPaidCents(world.db, made[2].id)).toBe(17600);
  });
});

describe("the link of a booking that has ended", () => {
  it("offers nothing to pay on its page, and is withdrawn once the processor says it was not paid", async () => {
    const made = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    const [link] = await links();
    // Cancelled while the link could not be withdrawn at the processor.
    world.failLinks = "Could not reach the payment processor.";
    expectOk(await ownerCancelBooking(world.db, made.ref, { refundCents: 0 }, world.manageDeps({ payments: square })));
    expect((await links())[0].status).toBe("open");
    expect(await getPayPage(world.db, link.id, deps())).toMatchObject({ status: "closed", closed: { released: false }, processorUrl: null, late: null });
    expect((await links())[0].status).toBe("open");
    // The processor answers again: opening the page withdraws the link.
    world.failLinks = null;
    expect(await getPayPage(world.db, link.id, deps())).toMatchObject({ status: "closed", processorUrl: null });
    expect((await links())[0].status).toBe("cancelled");
    expect(world.links[0].state.state).toBe("cancelled");
  });

  it("says a booking released for a reschedule code, and is withdrawn when the client opens the booking or the account", async () => {
    const withLinkLeftOpen = async (date: string, startMinute: number) => {
      const made = await madeInAdmin(date, startMinute);
      expectOk(await recordStudioPayment(world.db, owner, made.ref, { amountCents: 7600, method: "cash", note: "" }, NOW));
      expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
      world.failLinks = "Could not reach the payment processor.";
      expectOk(await requestRescheduleCode(world.db, made.ref, dana, world.manageDeps({ payments: square })));
      world.failLinks = null;
      return made;
    };
    const first = await withLinkLeftOpen(FAR, h(9));
    const second = await withLinkLeftOpen(FAR, h(13));
    const linkOf = async (bookingId: string) => (await links()).find((link) => link.bookingId === bookingId)!;
    world.failLinks = "Could not reach the payment processor.";
    expect(await getPayPage(world.db, (await linkOf(first.id)).id, deps())).toMatchObject({ status: "closed", closed: { released: true } });
    world.failLinks = null;

    await noticeBookingPayments(world.db, first.ref, dana, deps());
    expect((await linkOf(first.id)).status).toBe("cancelled");
    await noticePaidLinksOf(world.db, dana.email, deps());
    expect((await linkOf(second.id)).status).toBe("cancelled");
  });
});

describe("a page's wait for the processor", () => {
  it("is cut short, and the work goes on by itself", async () => {
    let done = false;
    const slow = new Promise<string>((resolve) =>
      setTimeout(() => {
        done = true;
        resolve("late");
      }, 200),
    );
    expect(await withinSeconds(0.02, slow)).toBeUndefined();
    expect(done).toBe(false);
    expect(await slow).toBe("late");
    expect(await withinSeconds(1, Promise.resolve("soon"))).toBe("soon");
  });
});

describe("the page a client's link leads to", () => {
  it("shows what is owed and where to pay, then that the payment arrived", async () => {
    const made = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    const [link] = await links();

    expect(await getPayPage(world.db, link.id, deps())).toEqual({
      id: link.id,
      status: "open",
      amountCents: 17600,
      ref: made.ref,
      studios: "Studio Blanche",
      when: "Wed, Nov 18, 2026, 2:00 PM",
      processorUrl: "https://pay.test/link_1",
      pretend: false,
      late: null,
      closed: null,
      foreign: false,
    });
    // The client pays at the processor and is sent back: opening the page finds the payment.
    clientPays();
    expect(await getPayPage(world.db, link.id, deps())).toMatchObject({ status: "paid", processorUrl: null });
    expect(await world.db.select().from(payments)).toHaveLength(1);
  });

  it("says a cancelled link is no longer valid, and knows no other address", async () => {
    const made = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    const [link] = await links();
    expectOk(await cancelPayLink(world.db, owner, made.ref, deps()));
    expect(await getPayPage(world.db, link.id, deps())).toMatchObject({ status: "cancelled", processorUrl: null });
    expect(await getPayPage(world.db, "00000000-0000-4000-8000-000000000000", deps())).toBeNull();
    expect(await getPayPage(world.db, "'; drop table bookings; --", deps())).toBeNull();
    expect(await getPayPage(world.db, made.ref, deps())).toBeNull();
  });

  it("offers a pretend payment in test mode only: never for a link a real processor made", async () => {
    // Test mode: the pretend processor, which has no payment page of its own.
    const test = { ...deps(), payments: world.provider };
    const made = await madeInAdmin(NEAR, h(14), "mock");
    expectOk(await sendPayLink(world.db, owner, made.ref, test));
    const [link] = await links();
    expect(await getPayPage(world.db, link.id, test)).toMatchObject({ status: "open", pretend: true, processorUrl: null });
    expect(await pretendToPay(world.db, link.id, NOW, world.provider)).toBe(true);
    expect(await pretendToPay(world.db, link.id, NOW, world.provider)).toBe(false); // once
    expect(await getPayPage(world.db, link.id, test)).toMatchObject({ status: "paid" });
    expect((await world.db.select().from(payments))[0]).toMatchObject({ provider: "mock", providerPaymentId: `mock_link_${link.id}`, amountCents: 17600 });

    // A link made by Square cannot be "paid" this way.
    const real = await madeInAdmin("2026-11-19");
    expectOk(await sendPayLink(world.db, owner, real.ref, deps()));
    const squareLink = (await links()).find((candidate) => candidate.bookingId === real.id)!;
    expect(await pretendToPay(world.db, squareLink.id, NOW, world.provider)).toBe(false);
    expect(await pretendToPay(world.db, "not-a-link", NOW, world.provider)).toBe(false);
    expect((await moneyOf(world.db, await row(real.ref))).dueCents).toBe(17600);
  });

  it("offers no pretend payment once another processor is set up, for a link the pretend one left behind", async () => {
    const test = { ...deps(), payments: world.provider };
    const made = await madeInAdmin(NEAR, h(14), "mock");
    expectOk(await sendPayLink(world.db, owner, made.ref, test));
    const [link] = await links();
    // Square's sandbox is set up in its place: the pretend processor's link can no longer be paid, for pretend or otherwise.
    const sandboxProvider = { ...world.provider, name: "square-sandbox" as const };
    const sandbox = { ...deps(), payments: sandboxProvider };
    expect(await getPayPage(world.db, link.id, sandbox)).toMatchObject({ status: "cancelled", pretend: false, processorUrl: null });
    expect(await pretendToPay(world.db, link.id, NOW, sandboxProvider)).toBe(false);
    expect(await pretendToPay(world.db, link.id, NOW, square)).toBe(false);
    expect(await pretendToPay(world.db, link.id, NOW, null)).toBe(false);
    expect(await world.db.select().from(payments)).toEqual([]);
    // It cannot be asked about, nor withdrawn the usual way: an owner closes it by hand.
    expect(await checkBookingPayLink(world.db, owner, made.ref, sandbox)).toEqual({
      ok: false,
      message:
        "This link was made by another card processor than the one set up now (in test mode, or with Square's other account), which the site cannot ask. Look it up there: an owner can then close it here by hand.",
    });
    expect(await cancelPayLink(world.db, owner, made.ref, sandbox)).toMatchObject({ ok: false });
    // Nor emailed again, with the processor set up now or with none.
    const resent = { ok: false, reason: "other_processor_open" };
    expect(await sendPayLink(world.db, owner, made.ref, sandbox)).toMatchObject(resent);
    expect(await sendPayLink(world.db, owner, made.ref, { ...deps(), payments: null })).toMatchObject(resent);
    expect(await world.emails("payment_link")).toHaveLength(1);
    expect(await closePayLinkByHand(world.db, owner, made.ref, sandbox)).toEqual({ ok: true, outcome: "cancelled" });
    // Then a new one, of the processor set up now, can be emailed; or money taken at the studio recorded.
    expect(await sendPayLink(world.db, owner, made.ref, sandbox)).toMatchObject({ ok: true, again: false });
    expectOk(await cancelPayLink(world.db, owner, made.ref, sandbox));
    expectOk(await recordStudioPayment(world.db, owner, made.ref, { amountCents: 17600, method: "cash", note: "" }, NOW));
  });

  it("is of the same kind of money as its booking: none is made with real money for a booking of test mode, nor a pretend one for a real booking", async () => {
    // A booking made in test mode, and Square's live account set up: a link would charge a real card for it.
    const pretend = await madeInAdmin(NEAR, h(14), "mock");
    expect(await sendPayLink(world.db, owner, pretend.ref, deps())).toEqual({
      ok: false,
      reason: "other_money",
      message:
        "This booking was made in test mode, when no money moved: it is not a real booking, and a payment link would charge a real card for it. Make the booking again here, then send the link for that one.",
    });
    // A real booking, on a site in test mode: a link would take a pretend payment for it.
    const real = await madeInAdmin(FAR, h(9));
    expect(await sendPayLink(world.db, owner, real.ref, { ...deps(), payments: world.provider })).toEqual({
      ok: false,
      reason: "other_money",
      message: "This is a real booking, and this site is in test mode: a payment link made here would take a pretend payment for it. Send the link from the live site.",
    });
    expect(world.links).toEqual([]);
    expect(await links()).toEqual([]);
    expect(await world.emails("payment_link")).toEqual([]);
  });

  it("tells the client of a booking that ends to say whether they paid a link the site can never ask about", async () => {
    const made = await madeInAdmin(NEAR, h(14), "mock");
    expectOk(await sendPayLink(world.db, owner, made.ref, { ...deps(), payments: world.provider }));
    const cancelled = expectOk(await cancelBooking(world.db, made.ref, dana, world.manageDeps({ payments: square })));
    expect(cancelled.message).toContain("The site cannot check the payment link for this booking. If you paid it, please contact us, and we will refund it.");
    const [notice] = await world.emails("owner_unseen_link");
    expect(notice.body).toContain("was made by another card processor than the one set up now (in test mode, or with Square's other account)");
    expect(notice.body).not.toContain("look the link up in Square");
    const notes = (await world.db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, made.id))).map((event) => event.note);
    expect(notes).toContain("The payment link for $176 was made by another card processor than the one set up now: the site cannot ask whether it was paid");
    // The studio's cancel says the same to the owner.
    const other = await madeInAdmin(FAR, h(9), "mock");
    expectOk(await sendPayLink(world.db, owner, other.ref, { ...deps(), payments: world.provider }));
    expect(await ownerCancelBooking(world.db, other.ref, { refundCents: 0 }, world.manageDeps({ payments: square }))).toMatchObject({ ok: true, unseenLink: "foreign" });
  });
});

describe("a page that could not check a booking's payment link", () => {
  it("says so, while the processor cannot answer, and not otherwise", async () => {
    const made = await madeInAdmin();
    // No link at all: nothing to say.
    expect(await noticeBookingPayments(world.db, made.ref, dana, deps())).toBeNull();
    expect(await noticePaidLinksOf(world.db, dana.email, deps())).toBeNull();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    expect(await noticeBookingPayments(world.db, made.ref, dana, deps())).toBeNull();
    world.links[0].state = { state: "unknown", message: "No answer from Square" };
    expect(await noticeBookingPayments(world.db, made.ref, dana, deps())).toBe("unanswered");
    expect(await noticePaidLinksOf(world.db, dana.email, deps())).toBe("unanswered");
    // A link of another processor than the one set up now can never be checked: the client is asked to say if they paid.
    expect(await noticeBookingPayments(world.db, made.ref, dana, { ...deps(), payments: world.provider })).toBe("foreign");
    expect(await noticePaidLinksOf(world.db, dana.email, { ...deps(), payments: world.provider })).toBe("foreign");
    const [link] = await links();
    expect(await getPayPage(world.db, link.id, { ...deps(), payments: world.provider })).toMatchObject({ status: "cancelled", foreign: true });
  });
});

describe("an owner closing by hand a link the processor then says was paid", () => {
  it("is told, for a booking that ended, that the payment is refunded in full", async () => {
    const made = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    world.links[0].state = { state: "unknown", message: "No answer from Square" };
    expectOk(await ownerCancelBooking(world.db, made.ref, { refundCents: 0 }, world.manageDeps({ payments: square })));
    clientPays();
    expect(await closePayLinkByHand(world.db, owner, made.ref, { ...deps(), ownerEmail: "owner@studio.test" })).toEqual({
      ok: true,
      outcome: "was_paid",
      late: { made: true },
    });
    expect(await netCardPaidCents(world.db, made.id)).toBe(0);
  });
});
