import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BookingSummary } from "@/components/BookingSummary";
import { bookings, paymentLinks, payments, promoCodes, refunds, settings, staffShifts } from "@/db/schema";
import { createAdminBooking, getAppointment } from "./appointments";
import type { AuthUser } from "./auth";
import { cancelBooking, ownerCancelBooking, requestRescheduleCode } from "./manage";
import { netCardPaidCents } from "./money";
import {
  cancelPayLink,
  checkBookingPayLink,
  checkOpenPayLinks,
  checkPayLink,
  getPayPage,
  openPayLinkOf,
  pretendToPay,
  sendPayLink,
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
    const online = expectOk(await world.book());
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
    expect(await checkPayLink(world.db, link.id, deps())).toBe("open");
    // No processor at all, or a different one from the link's own: nothing is known to have changed.
    expect(await checkPayLink(world.db, link.id, { ...deps(), payments: null })).toBe("open");
    expect(await checkPayLink(world.db, link.id, { ...deps(), payments: world.provider })).toBe("open");
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
    expect(await voidStudioPayment(world.db, owner, cash.id, "Wrong booking", NOW)).toEqual({ ok: true });
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

  it("records a payment the client made just before the booking was cancelled, and gives it back in full", async () => {
    const made = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    clientPays();
    // Cancelled before anyone asked the processor: withdrawing the link finds it paid and records the payment, which
    // the cancellation was worked out without: it is refunded to the card in full, and the client is told.
    expectOk(await cancelBooking(world.db, made.ref, dana, world.manageDeps({ payments: square })));
    expect((await links())[0].status).toBe("paid");
    expect(await world.db.select().from(refunds)).toMatchObject([{ amountCents: 17600, automatic: true, status: "succeeded" }]);
    expect(await netCardPaidCents(world.db, made.id)).toBe(0);
    const [late] = await world.emails("late_payment_refunded");
    expect(late.body).toContain(`Your payment of $176 for booking ${made.ref} arrived after the booking was cancelled, so it is refunded to your card in full.`);
    expect(await world.emails("payment_received")).toHaveLength(0);
  });

  it("gives back in full a payment that arrives after the booking was released for a reschedule code, which keeps what it was", async () => {
    const made = await madeInAdmin(FAR, h(9));
    expectOk(await recordStudioPayment(world.db, owner, made.ref, { amountCents: 7600, method: "cash", note: "" }, NOW));
    expectOk(await sendPayLink(world.db, owner, made.ref, deps()));
    // Paid on the processor's page, and not seen yet when the client releases the booking: the code is the cash.
    clientPays();
    const moved = expectOk(await requestRescheduleCode(world.db, made.ref, dana, world.manageDeps({ payments: square })));
    expect(moved.valueCents).toBe(7600);
    expect(await world.db.select().from(refunds)).toMatchObject([{ amountCents: 10000, status: "succeeded" }]);
    expect(await netCardPaidCents(world.db, made.id)).toBe(0);
    expect((await world.db.select().from(promoCodes).where(eq(promoCodes.code, moved.code)))[0].value).toBe(7600);
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
    const made = await madeInAdmin();
    expectOk(await sendPayLink(world.db, owner, made.ref, test));
    const [link] = await links();
    expect(await getPayPage(world.db, link.id, test)).toMatchObject({ status: "open", pretend: true, processorUrl: null });
    expect(await pretendToPay(world.db, link.id, NOW)).toBe(true);
    expect(await pretendToPay(world.db, link.id, NOW)).toBe(false); // once
    expect(await getPayPage(world.db, link.id, test)).toMatchObject({ status: "paid" });
    expect((await world.db.select().from(payments))[0]).toMatchObject({ provider: "mock", providerPaymentId: `mock_link_${link.id}`, amountCents: 17600 });

    // A link made by Square cannot be "paid" this way.
    const real = await madeInAdmin("2026-11-19");
    expectOk(await sendPayLink(world.db, owner, real.ref, deps()));
    const squareLink = (await links()).find((candidate) => candidate.bookingId === real.id)!;
    expect(await pretendToPay(world.db, squareLink.id, NOW)).toBe(false);
    expect(await pretendToPay(world.db, "not-a-link", NOW)).toBe(false);
    expect((await moneyOf(world.db, await row(real.ref))).dueCents).toBe(17600);
  });
});
