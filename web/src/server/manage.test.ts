import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, isNull, sql } from "drizzle-orm";
import { bookingEvents, bookings, emailOutbox, loyaltyLedger, paymentLinks, payments, promoCodes, refunds, settings, studioHolds, studios, users } from "@/db/schema";
import { formatCents } from "@/lib/domain/pricing";
import type { PaymentProvider } from "./payments";
import {
  cancelBooking,
  cancelOutcomeText,
  processRefund,
  getManageChoices,
  getManageOptions,
  netCardPaidCents,
  ownerCancelBooking,
  ownerRefund,
  checkUnsettledRefunds,
  requestRescheduleCode,
  retryOpenRefunds,
  type Actor,
} from "./manage";
import { issuePromo } from "./promos";
import { lapseReserved, settleReservedPayments } from "./reserved";
import { listRefundProblems } from "./admin";
import { createAdminBooking } from "./appointments";
import { quoteSelection, toBookingViews } from "./bookings";
import { cancelPayLink, checkPayLink, sendPayLink } from "./pay-links";
import { moneyOf, recordStudioPayment } from "./studio-payments";
import { assertOneKindOfMoney, clearTestMode, describeTestMode, LIVE_ON_TEST, moneyKindNow, otherMoneyNotice, payLinkPossible, TEST_ON_LIVE, testModeContents } from "./test-mode";
import type { AuthUser } from "./auth";
import { adjustStamps, cancelReward } from "./rewards";
import { contactMessageEmail, loginCodeEmail, queueEmail } from "./email";
import { owedCents } from "./money";
import { DEFAULT_SETTINGS, saveSetting } from "./settings";
import { createTestWorld, daysAfter, expectOk, FAR, h, hoursAfter, NEAR, NOW, OWNER_EMAIL, type TestWorld } from "./testing";

let world: TestWorld;
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(() => world.reset());

const bookingRow = async (ref: string) => (await world.db.select().from(bookings).where(eq(bookings.ref, ref)))[0];
const byToken = (token: string): Actor => ({ kind: "token", token });
const NEAR_START = new Date("2026-11-18T15:00:00Z"); // NEAR at 10:00 local

describe("cancelling", () => {
  it("14 or more days ahead: refunds the card automatically, less the 5% fee, and frees the slot", async () => {
    const booked = expectOk(await world.book({ date: FAR })); // $176
    const row = await bookingRow(booked.ref);

    const result = expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    expect(result).toMatchObject({ refundCents: 16720, feeCents: 880, refund: "sent" });
    expect(result.message).toBe("You will be refunded $167.20 to your card. The 5% processing fee ($8.80) is not refundable.");

    // The processor was asked once, for the right payment and amount.
    const [refundRow] = await world.db.select().from(refunds);
    expect(world.refundCalls).toEqual([
      { paymentId: `mock_${row.id}`, amountCents: 16720, idempotencyKey: refundRow.id, reason: `Cancellation of ${booked.ref}` },
    ]);
    expect(refundRow).toMatchObject({ status: "succeeded", automatic: true, amountCents: 16720 });
    expect((await world.db.select().from(payments))[0].refundedCents).toBe(16720);

    expect(await bookingRow(booked.ref)).toMatchObject({ status: "cancelled", cancelReason: "customer" });
    expect((await world.db.select().from(studioHolds)).every((hold) => !hold.active)).toBe(true);
    expect((await world.book({ date: FAR, customer: { name: "Next", email: "next@example.com", phone: "5550100100" } })).ok).toBe(true);

    const [toCustomer] = await world.emails("booking_cancelled");
    expect(toCustomer.toEmail).toBe("jane@example.com");
    expect(toCustomer.body).toContain("A refund of $167.20 is on its way to your card ($8.80 processing fee kept)");
    const [toOwner] = await world.emails("owner_refund_notice");
    expect(toOwner.toEmail).toBe(OWNER_EMAIL);
    expect(toOwner.body).toContain(`An automatic refund of $167.20 was sent for booking ${booked.ref}`);
  });

  it("in time, with a card refund that does not go through: the email says it has not reached the card, as the screen does", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    world.failRefunds = "The card account is closed";
    const result = expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    expect(result.refund).toBe("pending");
    const [mail] = await world.emails("booking_cancelled");
    expect(mail.body).toContain(
      "A refund of $167.20 is due to your card ($8.80 processing fee kept), and has not reached it yet: the studio has been told, and will see that it does.",
    );
    expect(mail.body).not.toContain("on its way");
    expect(await world.emails("refund_not_yet")).toHaveLength(0);
  });

  it("with a card refund that fails after its email has left: a second email puts it right", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    const deps = world.manageDeps();
    // The scheduled task takes the cancellation's email on its way while the processor is still answering, and the refund fails.
    const payments = {
      ...deps.payments!,
      refund: async () => {
        await world.db.update(emailOutbox).set({ attempts: 1 }).where(eq(emailOutbox.kind, "booking_cancelled"));
        return { ok: false as const, message: "The card account is closed" };
      },
    };
    expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), { ...deps, payments }));
    expect((await world.emails("booking_cancelled"))[0].body).toContain("is on its way to your card");
    const [followUp] = await world.emails("refund_not_yet");
    expect(followUp.toEmail).toBe("jane@example.com");
    expect(followUp.subject).toBe(`Your refund for booking ${booked.ref}`);
    expect(followUp.body).toContain(
      `About your cancelled booking ${booked.ref}: A refund of $167.20 is due to your card ($8.80 processing fee kept), and has not reached it yet: the studio has been told, and will see that it does.`,
    );
  });

  it("inside 7 days: cancels without a refund and says why", async () => {
    const booked = expectOk(await world.book({ date: NEAR }));
    const result = expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    expect(result).toMatchObject({ refundCents: 0, refund: "none" });
    expect(result.message).toBe("No refund is due, because the booking starts in less than 7 days.");
    expect(world.refundCalls).toHaveLength(0);
    expect(await world.db.select().from(refunds)).toHaveLength(0);
    expect((await bookingRow(booked.ref)).status).toBe("cancelled");
    expect((await world.emails("booking_cancelled"))[0].body).toContain("No refund is due");
    expect(await world.emails("owner_refund_notice")).toHaveLength(0);
  });

  it("draws the line at 7 days for a rental, not at 14 (the owner's answer of 2026-11-17)", async () => {
    // Ten days ahead was not refunded while the window was 14 days. It is again.
    const tenDays = expectOk(await world.book({ date: "2026-11-24" }));
    expect(expectOk(await cancelBooking(world.db, tenDays.ref, byToken(tenDays.manageToken), world.manageDeps()))).toMatchObject({
      refundCents: 17600 - 880,
      feeCents: 880,
      refund: "sent",
    });
    // Exactly 7 days before the start is still in time: Saturday 10:00 for a booking on Saturday the 21st at 10:00.
    const onTheLine = expectOk(await world.book({ date: "2026-11-21" }));
    expect(expectOk(await cancelBooking(world.db, onTheLine.ref, byToken(onTheLine.manageToken), world.manageDeps()))).toMatchObject({
      refundCents: 19000 - 950,
      feeCents: 950,
      refund: "sent",
    });
    // A quarter of an hour closer is too late.
    const tooLate = expectOk(await world.book({ date: "2026-11-21", startMinute: h(10) - 15 }));
    expect(expectOk(await cancelBooking(world.db, tooLate.ref, byToken(tooLate.manageToken), world.manageDeps()))).toMatchObject({
      refundCents: 0,
      refund: "none",
    });
  });

  it("uses the owner's refund window and fee", async () => {
    await world.db.insert(settings).values([
      { key: "refundWindowHours", value: 48 },
      { key: "refundFeePercent", value: 0 },
    ]);
    const booked = expectOk(await world.book({ date: NEAR })); // 4 days ahead
    const result = expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    expect(result).toMatchObject({ refundCents: 17600, feeCents: 0, refund: "sent" });
    expect(result.message).toBe("You will be refunded $176 to your card.");
  });

  it("only acts for the booking's own customer", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    const deps = world.manageDeps();
    expect(await cancelBooking(world.db, booked.ref, byToken("wrong-token-wrong-token-wrong"), deps)).toMatchObject({ ok: false, code: "not_found" });
    expect(await cancelBooking(world.db, booked.ref, { kind: "customer", email: "eve@example.com" }, deps)).toMatchObject({ ok: false, code: "not_found" });
    expect(await cancelBooking(world.db, "VS-AAAAAA", byToken(booked.manageToken), deps)).toMatchObject({ ok: false, code: "not_found" });
    expect(await cancelBooking(world.db, "not a ref", { kind: "owner" }, deps)).toMatchObject({ ok: false, code: "not_found" });
    expect((await bookingRow(booked.ref)).status).toBe("confirmed");
    expect(world.refundCalls).toHaveLength(0);

    // The signed-in customer, matched by email whatever its case.
    expect((await cancelBooking(world.db, booked.ref, { kind: "customer", email: "JANE@example.com" }, deps)).ok).toBe(true);
  });

  it("refunds once when cancelled twice, even at the same moment", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    const actor = byToken(booked.manageToken);
    const results = await Promise.all([
      cancelBooking(world.db, booked.ref, actor, world.manageDeps()),
      cancelBooking(world.db, booked.ref, actor, world.manageDeps()),
      cancelBooking(world.db, booked.ref, actor, world.manageDeps()),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "not_confirmed")).toHaveLength(2);
    expect(await world.db.select().from(refunds)).toHaveLength(1);
    expect(world.refundCalls).toHaveLength(1);
    expect(await world.emails("booking_cancelled")).toHaveLength(1);
  });

  it("is not possible once the booking has started", async () => {
    const booked = expectOk(await world.book({ date: NEAR }));
    const late = world.manageDeps({ now: hoursAfter(NEAR_START, 0.5) });
    expect(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), late)).toMatchObject({
      ok: false,
      code: "already_started",
      message: "This booking has already started.",
    });
  });

  it("gives a discount code back", async () => {
    const promo = (await issuePromo(world.db, { kind: "percent", value: 10, source: "loyalty", email: "jane@example.com", expiresAt: daysAfter(NOW, 60) }))!;
    const booked = expectOk(await world.book({ date: FAR, promoCode: promo.code }));
    expect((await world.db.select().from(promoCodes))[0].usedCount).toBe(1);
    const result = expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    expect(result.refundCents).toBe(15840 - 792); // refund is based on what the card paid
    expect((await world.db.select().from(promoCodes))[0].usedCount).toBe(0);
  });

  it("gives back an amount code the studio handed out, as it gives back a discount code", async () => {
    const gift = (await issuePromo(world.db, { kind: "amount", value: 5000, source: "manual", email: null, expiresAt: daysAfter(NOW, 60) }))!;
    const booked = expectOk(await world.book({ date: FAR, promoCode: gift.code, expectedTotalCents: 12600 }));
    const left = async () => (await world.db.select().from(promoCodes).where(eq(promoCodes.id, gift.id)))[0].value;
    expect(await left()).toBe(0);

    const result = expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    expect(result.refundCents).toBe(12600 - 630); // the card payment less the 5% fee
    expect(result.message).toContain("The code you used for this booking can be used again.");
    expect(await left()).toBe(5000);
    // The email says it too, beside the card refund.
    const mail = (await world.emails("booking_cancelled")).at(-1)!.body;
    expect(mail).toContain("A refund of $119.70 is on its way to your card");
    expect(mail).toContain("The code you used for this booking can be used again.");
  });

  it("names the refund window as the owner set it, in days only when it is whole days", () => {
    const late = { allowed: true, refundCents: 0, feeCents: 0, creditCents: 0, byHandCents: 0, why: "inside_window" } as const;
    const text = (refundWindowHours: number) => cancelOutcomeText(late, { ...DEFAULT_SETTINGS, refundWindowHours });
    expect(text(336)).toBe("No refund is due, because the booking starts in less than 14 days.");
    expect(text(DEFAULT_SETTINGS.refundWindowHours)).toBe("No refund is due, because the booking starts in less than 7 days.");
    expect(text(168)).toBe("No refund is due, because the booking starts in less than 7 days.");
    expect(text(100)).toBe("No refund is due, because the booking starts in less than 100 hours.");
    expect(text(36)).toBe("No refund is due, because the booking starts in less than 36 hours.");
    expect(text(1)).toBe("No refund is due, because the booking starts in less than 1 hour.");
  });

  it("tells the customer in advance what cancelling or moving would do", async () => {
    const early = expectOk(await world.book({ date: FAR }));
    expect(await getManageOptions(world.db, early.ref, byToken(early.manageToken), NOW)).toEqual({
      cancel: { allowed: true, refundCents: 16720, feeCents: 880, creditCents: 0, byHandCents: 0, why: "refund" },
      reschedule: { allowed: true, creditCents: 17600, discountCents: 0, feeCents: 0, nextFeeCents: 2000 },
    });
    const late = expectOk(await world.book({ date: NEAR }));
    expect(await getManageOptions(world.db, late.ref, byToken(late.manageToken), NOW)).toMatchObject({
      cancel: { allowed: true, refundCents: 0, why: "inside_window" },
      reschedule: { allowed: true, creditCents: 17600 },
    });
    expect(await getManageOptions(world.db, late.ref, byToken("wrong-token-wrong-token-wrong"), NOW)).toBeNull();
  });
});

describe("when a refund cannot be sent", () => {
  it("keeps the cancellation, alerts the owner once, and retries until it goes through", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    world.failRefunds = "Card network down";

    const result = expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    expect(result).toMatchObject({ refundCents: 16720, refund: "pending" });
    expect((await bookingRow(booked.ref)).status).toBe("cancelled");
    expect((await world.db.select().from(refunds))[0]).toMatchObject({ status: "failed", error: "Card network down" });
    const [alert] = await world.emails("owner_refund_failed");
    expect(alert.subject).toBe(`ACTION NEEDED: refund failed for ${booked.ref}`);
    expect(alert.body).toContain("Card network down");

    // Still failing: no second alert.
    expect(await retryOpenRefunds(world.db, world.manageDeps())).toEqual({ succeeded: 0, failed: 1 });
    expect(await world.emails("owner_refund_failed")).toHaveLength(1);

    // Back up: the same refund goes through, with the same idempotency key every time.
    world.failRefunds = null;
    expect(await retryOpenRefunds(world.db, world.manageDeps())).toEqual({ succeeded: 1, failed: 0 });
    expect(new Set(world.refundCalls.map((call) => call.idempotencyKey)).size).toBe(1);
    expect(world.refundCalls).toHaveLength(3);
    expect((await world.db.select().from(refunds))[0]).toMatchObject({ status: "succeeded", error: null });
    expect((await world.db.select().from(payments))[0].refundedCents).toBe(16720);
    expect(await world.emails("owner_refund_notice")).toHaveLength(1);

    // Nothing left to retry.
    expect(await retryOpenRefunds(world.db, world.manageDeps())).toEqual({ succeeded: 0, failed: 0 });
    expect(world.refundCalls).toHaveLength(3);
  });

  it("records the refund as waiting when no processor is configured, and sends it later", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    const result = expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps({ payments: null })));
    expect(result.refund).toBe("waiting");
    expect((await world.db.select().from(refunds))[0].status).toBe("pending");
    // The money is already spoken for: it cannot be refunded a second time.
    expect(await netCardPaidCents(world.db, (await bookingRow(booked.ref)).id)).toBe(880);

    expect(await retryOpenRefunds(world.db, world.manageDeps())).toEqual({ succeeded: 1, failed: 0 });
    expect((await world.db.select().from(refunds))[0].status).toBe("succeeded");
  });
});

describe("a refund tried twice at once", () => {
  it("that fails is told once: one line in the history, one alert to the owner", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    // Recorded with no processor to send it to: it waits, as one does between the cancellation and its sending.
    expectOk(await ownerRefund(world.db, booked.ref, { amountCents: 5000, reason: "" }, world.manageDeps({ payments: null })));
    const [refund] = await world.db.select().from(refunds);
    expect(refund.status).toBe("pending");
    world.failRefunds = "The card account is closed";
    // The request that recorded it, and the scheduled task beside it.
    const deps = world.manageDeps();
    expect(await Promise.all([processRefund(world.db, refund.id, deps), processRefund(world.db, refund.id, deps)])).toEqual(["failed", "failed"]);
    const bookingId = (await bookingRow(booked.ref)).id;
    const notes = (await world.db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, bookingId))).map((event) => event.note);
    expect(notes.filter((note) => note.startsWith("The refund of $50 did not go through"))).toHaveLength(1);
    expect(await world.emails("owner_refund_failed")).toHaveLength(1);
  });

  it("that goes through on an attempt with an earlier clock still ends its history saying so", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    expectOk(await ownerRefund(world.db, booked.ref, { amountCents: 5000, reason: "" }, world.manageDeps({ payments: null })));
    const [refund] = await world.db.select().from(refunds);
    const deps = world.manageDeps();
    // The request's attempt, at NOW, is answered slowly and goes through; the scheduled task's, a minute later, is refused at once.
    const slow = {
      ...deps.payments!,
      refund: async (request: Parameters<NonNullable<typeof deps.payments>["refund"]>[0]) => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return deps.payments!.refund(request);
      },
    };
    const refused = { ...deps.payments!, refund: async () => ({ ok: false as const, message: "Idempotency key in use" }) };
    await Promise.all([
      processRefund(world.db, refund.id, { ...deps, payments: slow }),
      processRefund(world.db, refund.id, { ...deps, payments: refused, now: hoursAfter(NOW, 1 / 60) }),
    ]);
    const bookingId = (await bookingRow(booked.ref)).id;
    const events = await world.db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, bookingId)).orderBy(bookingEvents.at);
    expect(events.at(-1)?.note).toBe("The refund of $50 went through when it was tried again");
  });

  it("that fails once and goes through on the other attempt says, last, that it went through", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    expectOk(await ownerRefund(world.db, booked.ref, { amountCents: 5000, reason: "" }, world.manageDeps({ payments: null })));
    const [refund] = await world.db.select().from(refunds);
    const deps = world.manageDeps();
    // One attempt is answered slowly and goes through; the other is refused at once.
    let calls = 0;
    const payments = {
      ...deps.payments!,
      refund: async (request: Parameters<NonNullable<typeof deps.payments>["refund"]>[0]) => {
        calls += 1;
        if (calls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return deps.payments!.refund(request);
        }
        return { ok: false as const, message: "The card account is closed" };
      },
    };
    const both = await Promise.all([processRefund(world.db, refund.id, { ...deps, payments }), processRefund(world.db, refund.id, { ...deps, payments })]);
    expect(both.sort()).toEqual(["failed", "succeeded"]);
    expect((await world.db.select().from(refunds))[0].status).toBe("succeeded");
    const bookingId = (await bookingRow(booked.ref)).id;
    const notes = (await world.db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, bookingId))).map((event) => event.note);
    expect(notes.at(-1)).toBe("The refund of $50 went through when it was tried again");
  });
});

/** Square accepts most refunds as pending and completes them shortly after; it may still reject one then. */
describe("a refund the processor accepted without completing it", () => {
  it("is marked complete once the processor says so, and not asked about again", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    world.pendingRefunds = true;
    expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    expect((await world.db.select().from(refunds))[0]).toMatchObject({ status: "succeeded", settledAt: null });

    world.refundAnswer = { state: "pending" };
    expect(await checkUnsettledRefunds(world.db, world.manageDeps())).toEqual({ settled: 0, rejected: 0 });
    world.refundAnswer = { state: "unknown", message: "No answer from Square" };
    expect(await checkUnsettledRefunds(world.db, world.manageDeps())).toEqual({ settled: 0, rejected: 0 });
    world.refundAnswer = { state: "completed" };
    expect(await checkUnsettledRefunds(world.db, world.manageDeps())).toEqual({ settled: 1, rejected: 0 });
    expect((await world.db.select().from(refunds))[0].settledAt).toEqual(NOW);
    expect(await checkUnsettledRefunds(world.db, world.manageDeps())).toEqual({ settled: 0, rejected: 0 });
  });

  it("becomes a failed refund the owner is told about, when the processor rejects it after all", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    world.pendingRefunds = true;
    expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    expect((await world.db.select().from(payments))[0].refundedCents).toBe(16720);

    world.refundAnswer = { state: "rejected", message: "Square marked the refund REJECTED" };
    expect(await checkUnsettledRefunds(world.db, world.manageDeps())).toEqual({ settled: 0, rejected: 1 });
    expect((await world.db.select().from(refunds))[0]).toMatchObject({ status: "failed", error: "Square marked the refund REJECTED" });
    // The money did not go back: the card's payment counts it as not refunded again.
    expect((await world.db.select().from(payments))[0].refundedCents).toBe(0);
    const [alert] = await world.emails("owner_refund_failed");
    expect(alert.subject).toBe(`ACTION NEEDED: refund failed for ${booked.ref}`);
    expect(alert.body).toContain("Square accepted the refund, then did not make it. Its answer: Square marked the refund REJECTED.");
    // The booking's history says so, as it says a refund that fails at once.
    const bookingId = (await bookingRow(booked.ref)).id;
    const said = async () => (await world.db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, bookingId))).map((event) => event.note);
    expect(await said()).toContain("Square accepted the refund of $167.20, then did not make it, and it is tried again. Its answer: Square marked the refund REJECTED.");
    // Asked again, nothing more happens: it is a failed refund now, retried with the others.
    expect(await checkUnsettledRefunds(world.db, world.manageDeps())).toEqual({ settled: 0, rejected: 0 });
    world.pendingRefunds = false;
    const later = new Date(NOW.getTime() + 5 * 86_400_000);
    expect(await retryOpenRefunds(world.db, world.manageDeps({ now: later }))).toEqual({ succeeded: 1, failed: 0 });
    expect((await world.db.select().from(payments))[0].refundedCents).toBe(16720);
    // Made when it was tried again: dated that day, and its history says so.
    expect((await world.db.select().from(refunds))[0].createdAt).toEqual(later);
    expect((await said()).at(-1)).toBe("The refund of $167.20 went through when it was tried again");
  });

  it("is never asked about when the processor completed it at once, or when there is no processor", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    expect((await world.db.select().from(refunds))[0].settledAt).toEqual(NOW);
    world.refundAnswer = { state: "rejected", message: "Square marked the refund REJECTED" };
    expect(await checkUnsettledRefunds(world.db, world.manageDeps())).toEqual({ settled: 0, rejected: 0 });
    expect(await checkUnsettledRefunds(world.db, world.manageDeps({ payments: null }))).toEqual({ settled: 0, rejected: 0 });
    expect((await world.db.select().from(refunds))[0].status).toBe("succeeded");
  });
});

describe("the reschedule code", () => {
  it("says what moving the new booking again costs by today's settings, which the new booking takes (the tester's finding of 2026-11-18)", async () => {
    const first = expectOk(await world.book({ date: FAR }));
    // The owners raise the fee for a further move from $20 to $35 after the booking was made.
    expect(await saveSetting(world.db, "rescheduleFeeCents", 3500)).toBe(true);
    const told = (await getManageChoices(world.db, first.ref, byToken(first.manageToken), NOW))!.reschedule.text;
    expect(told).toContain("Moving the new booking again would cost $35.");
    const released = expectOk(await requestRescheduleCode(world.db, first.ref, byToken(first.manageToken), world.manageDeps()));
    const second = expectOk(await world.book({ date: FAR, startMinute: h(14), promoCode: released.code, paymentToken: undefined }));
    // The new booking was made under today's terms: what it was told is what it costs.
    expect((await getManageChoices(world.db, second.ref, byToken(second.manageToken), NOW))!.reschedule.text).toContain("less the $35 fee");
  });

  it("releases the booking and emails a code worth what was paid", async () => {
    const booked = expectOk(await world.book({ date: NEAR })); // inside the refund window
    const row = await bookingRow(booked.ref);

    const result = expectOk(await requestRescheduleCode(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    expect(result.code).toMatch(/^MOVE-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(result.valueCents).toBe(17600);
    expect(result.expiresAt).toEqual(daysAfter(NOW, 90));

    expect(await bookingRow(booked.ref)).toMatchObject({ status: "cancelled", cancelReason: "rescheduled" });
    expect((await world.db.select().from(studioHolds)).every((hold) => !hold.active)).toBe(true);
    expect(world.refundCalls).toHaveLength(0); // no money goes back to the card
    expect(await world.db.select().from(refunds)).toHaveLength(0);

    const [code] = await world.db.select().from(promoCodes);
    expect(code).toMatchObject({
      code: result.code,
      kind: "amount",
      value: 17600,
      source: "reschedule",
      email: "jane@example.com",
      rescheduleGeneration: 1,
      originBookingId: row.id,
    });

    const [mail] = await world.emails("reschedule_code");
    expect(mail.toEmail).toBe("jane@example.com");
    expect(mail.body).toContain(`Reschedule code: ${result.code}`);
    expect(mail.body).toContain("credit of $176");
    expect(mail.body).toContain("https://studio.test/book");
  });

  it("carries what a discount code took off, so the same booking at a new time costs nothing more", async () => {
    const promo = (await issuePromo(world.db, { kind: "percent", value: 10, source: "loyalty", email: "jane@example.com", expiresAt: daysAfter(NOW, 60) }))!;
    const first = expectOk(await world.book({ date: NEAR, promoCode: promo.code }));
    expect(first.totalCents).toBe(15840); // $176 less 10%

    const choices = await getManageChoices(world.db, first.ref, byToken(first.manageToken), NOW);
    expect(choices?.reschedule).toEqual({
      allowed: true,
      offered: true,
      text: "This booking will be released and you will get a code worth $176, valid for 90 days, to book a new time. That is what you paid plus the $17.60 your discount code took off. A booking made with the code cannot be refunded. Moving the new booking again would cost $20.",
    });
    const moved = expectOk(await requestRescheduleCode(world.db, first.ref, byToken(first.manageToken), world.manageDeps()));
    expect(moved.valueCents).toBe(17600);
    const [mail] = await world.emails("reschedule_code");
    expect(mail.body).toContain("What you paid, plus the $17.60 your discount code took off, is now a credit of $176.");

    // The discount code stays spent. The credit alone pays for the same booking at the new time.
    expect((await world.db.select().from(promoCodes).where(eq(promoCodes.id, promo.id)))[0].usedCount).toBe(1);
    const second = expectOk(await world.book({ date: FAR, promoCode: moved.code, paymentToken: undefined }));
    expect(second.totalCents).toBe(0);
    expect(world.charges).toHaveLength(1); // only the first payment: nothing more was charged
  });

  it("says that bookings cannot be moved, and offers no button, when the owner switched moving off", async () => {
    await world.db.insert(settings).values({ key: "maxReschedules", value: 0 });
    const booked = expectOk(await world.book({ date: FAR }));
    const choices = await getManageChoices(world.db, booked.ref, byToken(booked.manageToken), NOW);
    expect(choices?.reschedule).toEqual({
      allowed: false,
      offered: false,
      text: "Bookings cannot be moved online. Please call the studio.",
    });
    expect(await requestRescheduleCode(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps())).toMatchObject({
      ok: false,
      code: "not_offered",
    });
  });

  it("books the new time for free, and that booking can no longer be refunded", async () => {
    const first = expectOk(await world.book({ date: NEAR }));
    const { code } = expectOk(await requestRescheduleCode(world.db, first.ref, byToken(first.manageToken), world.manageDeps()));

    // The freed slot can be taken by the same customer at a new date, paying nothing.
    const second = expectOk(await world.book({ date: FAR, promoCode: code, paymentToken: undefined }));
    expect(second.totalCents).toBe(0);
    expect(world.charges).toHaveLength(1); // only the original payment
    expect(await bookingRow(second.ref)).toMatchObject({ rescheduledCount: 1, creditAppliedCents: 17600 });

    // 25 days ahead would normally be refundable. A moved booking is not. It can be moved again, for the fee.
    expect(await getManageOptions(world.db, second.ref, byToken(second.manageToken), NOW)).toEqual({
      cancel: { allowed: true, refundCents: 0, feeCents: 0, creditCents: 0, byHandCents: 0, why: "rescheduled" },
      reschedule: { allowed: true, creditCents: 15600, discountCents: 0, feeCents: 2000, nextFeeCents: 2000 },
    });
    const cancelled = expectOk(await cancelBooking(world.db, second.ref, byToken(second.manageToken), world.manageDeps()));
    expect(cancelled).toMatchObject({ refundCents: 0, refund: "none" });
    expect(cancelled.message).toBe("No refund is due, because this booking was made with a reschedule code.");
    expect(world.refundCalls).toHaveLength(0);
  });

  it("moves a booking a second time for the fee, taken off the new code (the owner's answer of 2026-11-17)", async () => {
    const first = expectOk(await world.book({ date: NEAR })); // $176 by card
    const one = expectOk(await requestRescheduleCode(world.db, first.ref, byToken(first.manageToken), world.manageDeps()));
    expect(one.valueCents).toBe(17600); // the first move is free
    const second = expectOk(await world.book({ date: FAR, promoCode: one.code, paymentToken: undefined }));

    // Before she presses, the page says what the code will be worth, and why.
    const choices = await getManageChoices(world.db, second.ref, byToken(second.manageToken), NOW);
    expect(choices?.reschedule).toEqual({
      allowed: true,
      offered: true,
      text: "This booking will be released and you will get a code worth $156, valid for 90 days, to book a new time. That is what you paid less the $20 fee for moving a booking again. A booking made with the code cannot be refunded.",
    });
    const two = expectOk(await requestRescheduleCode(world.db, second.ref, byToken(second.manageToken), world.manageDeps(), choices!.reschedule.text));
    expect(two.valueCents).toBe(15600);
    const [code] = await world.db.select().from(promoCodes).where(eq(promoCodes.code, two.code));
    expect(code).toMatchObject({ value: 15600, rescheduleGeneration: 2, source: "reschedule" });
    const mails = (await world.emails("reschedule_code")).map((mail) => mail.body);
    expect(mails).toHaveLength(2);
    expect(mails.find((body) => body.includes(second.ref))).toContain(
      `Your booking ${second.ref} has been released. What you paid, less the $20 fee for moving a booking again, is now a credit of $156.`,
    );
    expect(mails.find((body) => body.includes(first.ref))).toContain(`Your booking ${first.ref} has been released, and what you paid is now a credit of $176.`);
    const secondId = (await bookingRow(second.ref)).id;
    const notes = (await world.db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, secondId))).map((event) => event.note);
    expect(notes).toContain("Released for a reschedule code worth $156, after the $20 fee for moving a booking again");

    // The same booking at a new time costs the fee: the code pays the rest. No money is charged for the move itself.
    expect(world.charges).toHaveLength(1);
    const third = expectOk(await world.book({ date: FAR, startMinute: h(14), promoCode: two.code, expectedTotalCents: 2000 }));
    expect(third.totalCents).toBe(2000);
    expect(world.charges.at(-1)?.amountCents).toBe(2000);
    expect(await bookingRow(third.ref)).toMatchObject({ rescheduledCount: 2, creditAppliedCents: 15600 });
    // And once more, the same fee: the $20 paid by card moves with the credit.
    expect((await getManageOptions(world.db, third.ref, byToken(third.manageToken), NOW))?.reschedule).toEqual({
      allowed: true,
      creditCents: 15600,
      discountCents: 0,
      feeCents: 2000,
      nextFeeCents: 2000,
    });
  });

  it("keeps the fee the booking was made under when the owners change it while the page is open", async () => {
    const first = expectOk(await world.book({ date: NEAR }));
    const one = expectOk(await requestRescheduleCode(world.db, first.ref, byToken(first.manageToken), world.manageDeps()));
    const second = expectOk(await world.book({ date: FAR, promoCode: one.code, paymentToken: undefined }));
    const seen = (await getManageChoices(world.db, second.ref, byToken(second.manageToken), NOW))!.reschedule.text;
    // A change of the settings applies to bookings made from then on (question 10): what the client read still holds.
    await world.db.insert(settings).values({ key: "rescheduleFeeCents", value: 3000 });
    expect(await requestRescheduleCode(world.db, second.ref, byToken(second.manageToken), world.manageDeps(), seen)).toMatchObject({ ok: true, valueCents: 15600 });
  });

  it("refuses a second move whose fee would leave no credit, and any second move while the owners set no fee", async () => {
    const first = expectOk(await world.book({ date: NEAR, durationMinutes: 60 })); // $88
    const one = expectOk(await requestRescheduleCode(world.db, first.ref, byToken(first.manageToken), world.manageDeps()));
    // Made while a further move costs $88: the booking keeps that fee (question 10).
    await world.db.insert(settings).values({ key: "rescheduleFeeCents", value: 8800 });
    const second = expectOk(await world.book({ date: FAR, durationMinutes: 60, promoCode: one.code, paymentToken: undefined }));
    expect(await requestRescheduleCode(world.db, second.ref, byToken(second.manageToken), world.manageDeps())).toMatchObject({
      ok: false,
      code: "fee_not_covered",
      message: "Moving a booking again costs $88, and this booking is not worth more than that, so no credit would be left to move. Please call the studio.",
    });
    expect((await bookingRow(second.ref)).status).toBe("confirmed");

    // Made while the owners set no fee for a further move: it cannot be moved again online.
    const firstAgain = expectOk(await world.book({ date: NEAR, startMinute: h(14), durationMinutes: 60 }));
    const two = expectOk(await requestRescheduleCode(world.db, firstAgain.ref, byToken(firstAgain.manageToken), world.manageDeps()));
    await world.db.update(settings).set({ value: 0 }).where(eq(settings.key, "rescheduleFeeCents"));
    const third = expectOk(await world.book({ date: FAR, startMinute: h(14), durationMinutes: 60, promoCode: two.code, paymentToken: undefined }));
    expect(await getManageChoices(world.db, third.ref, byToken(third.manageToken), NOW)).toMatchObject({
      reschedule: { allowed: false, offered: true, text: "This booking was already moved and cannot be moved again online. Please call the studio." },
    });
    expect(await requestRescheduleCode(world.db, third.ref, byToken(third.manageToken), world.manageDeps())).toMatchObject({
      ok: false,
      code: "limit_reached",
    });
    expect((await bookingRow(third.ref)).status).toBe("confirmed");
  });

  it("charges only the difference for a dearer time and carries the whole value if moved again", async () => {
    // Two free moves and no fee after them: the third is refused.
    await world.db.insert(settings).values([
      { key: "maxReschedules", value: 2 },
      { key: "rescheduleFeeCents", value: 0 },
    ]);
    const first = expectOk(await world.book({ date: NEAR, durationMinutes: 60 })); // $88
    const one = expectOk(await requestRescheduleCode(world.db, first.ref, byToken(first.manageToken), world.manageDeps()));
    expect(one.valueCents).toBe(8800);

    const second = expectOk(await world.book({ date: FAR, durationMinutes: 120, promoCode: one.code, expectedTotalCents: 8800 })); // $176
    expect(world.charges.at(-1)?.amountCents).toBe(8800);

    const two = expectOk(await requestRescheduleCode(world.db, second.ref, byToken(second.manageToken), world.manageDeps()));
    expect(two.valueCents).toBe(17600); // $88 from the card plus the $88 credit
    expect((await world.db.select().from(promoCodes).where(eq(promoCodes.code, two.code)))[0].rescheduleGeneration).toBe(2);

    const third = expectOk(await world.book({ date: FAR, startMinute: h(14), promoCode: two.code, paymentToken: undefined }));
    expect(await requestRescheduleCode(world.db, third.ref, byToken(third.manageToken), world.manageDeps())).toMatchObject({
      ok: false,
      code: "limit_reached",
    });
  });

  it("is refused too close to the start, with the owner's cut-off", async () => {
    const booked = expectOk(await world.book({ date: NEAR }));
    const late = world.manageDeps({ now: hoursAfter(NEAR_START, -23) });
    expect(await requestRescheduleCode(world.db, booked.ref, byToken(booked.manageToken), late)).toMatchObject({
      ok: false,
      code: "too_late",
      message: "Bookings can be moved online until 24 hours before they start. Please call the studio.",
    });
    expect((await bookingRow(booked.ref)).status).toBe("confirmed");

    // A shorter cut-off applies to bookings made from then on; this one keeps its 24 hours (question 10).
    await world.db.insert(settings).values({ key: "rescheduleCutoffHours", value: 2 });
    expect((await requestRescheduleCode(world.db, booked.ref, byToken(booked.manageToken), late)).ok).toBe(false);
    const later = expectOk(await world.book({ date: NEAR, startMinute: h(14) }));
    const lateForLater = world.manageDeps({ now: hoursAfter(NEAR_START, -19) }); // 23 hours before 14:00
    expect((await requestRescheduleCode(world.db, later.ref, byToken(later.manageToken), lateForLater)).ok).toBe(true);
  });

  it("issues one code when asked twice at the same moment", async () => {
    const booked = expectOk(await world.book({ date: NEAR }));
    const actor = byToken(booked.manageToken);
    const results = await Promise.all([
      requestRescheduleCode(world.db, booked.ref, actor, world.manageDeps()),
      requestRescheduleCode(world.db, booked.ref, actor, world.manageDeps()),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await world.db.select().from(promoCodes)).toHaveLength(1);
    expect(await world.emails("reschedule_code")).toHaveLength(1);
  });

  it("is refused for someone who is not the customer, and after cancelling", async () => {
    const booked = expectOk(await world.book({ date: NEAR }));
    expect(await requestRescheduleCode(world.db, booked.ref, byToken("wrong-token-wrong-token-wrong"), world.manageDeps())).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await requestRescheduleCode(world.db, booked.ref, { kind: "customer", email: "eve@example.com" }, world.manageDeps())).toMatchObject({
      ok: false,
      code: "not_found",
    });
    await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps());
    expect(await requestRescheduleCode(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps())).toMatchObject({
      ok: false,
      code: "not_confirmed",
    });
    expect(await world.db.select().from(promoCodes)).toHaveLength(0);
  });

  it("cannot be combined with a refund for the same money", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    const actor = byToken(booked.manageToken);
    const results = await Promise.all([
      cancelBooking(world.db, booked.ref, actor, world.manageDeps()),
      requestRescheduleCode(world.db, booked.ref, actor, world.manageDeps()),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const refunded = (await world.db.select().from(refunds)).length;
    const credited = (await world.db.select().from(promoCodes)).length;
    expect(refunded + credited).toBe(1);
  });
});

describe("a booking released for a reschedule code", () => {
  it("refunds only what is left on its code, and the refund comes off the code: the money comes back once", async () => {
    const booked = expectOk(await world.book({ date: FAR })); // $176 by card
    const moved = expectOk(await requestRescheduleCode(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    const code = async () => (await world.db.select().from(promoCodes).where(eq(promoCodes.code, moved.code)))[0];
    expect((await code()).value).toBe(17600);
    // All of it as well as the code: refused, and the reason named.
    expect(await ownerRefund(world.db, booked.ref, { amountCents: 17601, reason: "" }, world.manageDeps())).toMatchObject({
      ok: false,
      message: `At most $176 can be refunded to the card for this booking: what was paid is on its reschedule code ${moved.code}, which has $176 left.`,
    });
    expectOk(await ownerRefund(world.db, booked.ref, { amountCents: 5000, reason: "Asked for part back" }, world.manageDeps()));
    expect((await code()).value).toBe(12600);
    // The client is told what is left on their code.
    expect((await world.emails("reschedule_code_refund"))[0].body).toContain(
      `A refund of $50 to your card for booking ${booked.ref} came off your reschedule code ${moved.code}, which now has $126 left.`,
    );
    const bookingId = (await bookingRow(booked.ref)).id;
    const notes = (await world.db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, bookingId))).map((event) => event.note);
    expect(notes.at(-1)).toBe(`Refund $50 to the card: Asked for part back; taken off the reschedule code ${moved.code}, which has $126 left`);
    // Spent on a new booking meanwhile: no more than is left can be refunded.
    expectOk(await world.book({ date: FAR, startMinute: h(15), durationMinutes: 60, promoCode: moved.code, paymentToken: undefined })); // $88
    expect((await code()).value).toBe(3800);
    expect(await ownerRefund(world.db, booked.ref, { amountCents: 5000, reason: "" }, world.manageDeps())).toMatchObject({ ok: false, code: "bad_amount" });
    expectOk(await ownerRefund(world.db, booked.ref, { amountCents: 3800, reason: "" }, world.manageDeps()));
    expect((await code()).value).toBe(0);
  });
});

describe("a booking released for a reschedule code that an owner cancelled", () => {
  it("still refunds only what was left on the code: what was spent of it stays spent", async () => {
    const booked = expectOk(await world.book({ date: FAR })); // $176 by card
    const moved = expectOk(await requestRescheduleCode(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    expectOk(await world.book({ date: FAR, startMinute: h(15), durationMinutes: 60, promoCode: moved.code, paymentToken: undefined })); // $88 of it
    const [code] = await world.db.select().from(promoCodes).where(eq(promoCodes.code, moved.code));
    await world.db.update(promoCodes).set({ voidedAt: NOW }).where(eq(promoCodes.id, code.id));
    expect(await ownerRefund(world.db, booked.ref, { amountCents: 17600, reason: "" }, world.manageDeps())).toMatchObject({
      ok: false,
      message: `At most $88 can be refunded to the card for this booking: what was paid is on its reschedule code ${moved.code}, which has $88 left.`,
    });
    expectOk(await ownerRefund(world.db, booked.ref, { amountCents: 5000, reason: "" }, world.manageDeps()));
    // The client is not told of credit they can no longer use.
    expect((await world.emails("reschedule_code_refund"))[0].body).toContain(
      `A refund of $50 to your card for booking ${booked.ref} came off your reschedule code ${moved.code}. That code can no longer be used.`,
    );
    expectOk(await ownerRefund(world.db, booked.ref, { amountCents: 3800, reason: "" }, world.manageDeps()));
    expect((await world.emails("reschedule_code_refund"))[1].body).toContain(`came off your reschedule code ${moved.code}, which has nothing left on it.`);
    expect((await world.db.select().from(promoCodes).where(eq(promoCodes.id, code.id)))[0].value).toBe(0);
    expect(await ownerRefund(world.db, booked.ref, { amountCents: 100, reason: "" }, world.manageDeps())).toMatchObject({ ok: false, code: "bad_amount" });
  });
});

describe("a refund off a reschedule code that does not go through", () => {
  it("puts the client's email right: it has not reached the card yet", async () => {
    const booked = expectOk(await world.book({ date: FAR })); // $176 by card
    const moved = expectOk(await requestRescheduleCode(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    world.failRefunds = "The card account is closed";
    expect(await ownerRefund(world.db, booked.ref, { amountCents: 5000, reason: "" }, world.manageDeps())).toMatchObject({ ok: true, refund: "pending" });
    const told = await world.emails("reschedule_code_refund");
    expect(told).toHaveLength(1);
    expect(told[0].body).toContain(
      `A refund of $50 to your card for booking ${booked.ref} came off your reschedule code ${moved.code}, which now has $126 left. The refund has not reached your card yet: the studio has been told, and will see that it does.`,
    );
  });

  it("follows an email that has already left with one that says so", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    expectOk(await requestRescheduleCode(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    // Every message waiting goes out at the moment the refund is sent, before its answer comes back.
    const sending: PaymentProvider = {
      ...world.provider,
      refund: async () => {
        await world.db.update(emailOutbox).set({ sentAt: NOW, attempts: 1 }).where(isNull(emailOutbox.sentAt));
        return { ok: false, message: "The card account is closed" };
      },
    };
    expectOk(await ownerRefund(world.db, booked.ref, { amountCents: 5000, reason: "" }, world.manageDeps({ payments: sending })));
    const told = await world.emails("reschedule_code_refund");
    expect(told).toHaveLength(2);
    expect(told[0].body).not.toContain("has not reached your card yet");
    expect(told[1].body).toContain("The refund has not reached your card yet");
  });
});

describe("the owner", () => {
  it("gives the customer's code back when the studio cancels a visit that has not started", async () => {
    // A booking paid with a reschedule credit: the customer could not get that credit back by cancelling.
    const first = expectOk(await world.book({ date: NEAR }));
    const moved = expectOk(await requestRescheduleCode(world.db, first.ref, byToken(first.manageToken), world.manageDeps()));
    const second = expectOk(await world.book({ date: FAR, promoCode: moved.code, paymentToken: undefined }));
    const credit = async () => (await world.db.select().from(promoCodes).where(eq(promoCodes.code, moved.code)))[0].value;
    expect(await credit()).toBe(0);

    expectOk(await ownerCancelBooking(world.db, second.ref, { refundCents: 0 }, world.manageDeps()));
    expect(await credit()).toBe(17600);
    expect((await world.emails("booking_cancelled")).at(-1)?.body).toContain("The code you used for this booking can be used again.");
  });

  it("keeps a code spent when the cancellation comes after the visit started", async () => {
    const promo = (await issuePromo(world.db, { kind: "percent", value: 10, source: "loyalty", email: "jane@example.com", expiresAt: daysAfter(NOW, 60) }))!;
    const booked = expectOk(await world.book({ date: NEAR, promoCode: promo.code }));
    const afterStart = world.manageDeps({ now: hoursAfter(NEAR_START, 1) });
    expectOk(await ownerCancelBooking(world.db, booked.ref, { refundCents: 5000 }, afterStart));
    expect((await world.db.select().from(promoCodes).where(eq(promoCodes.id, promo.id)))[0].usedCount).toBe(1);
    expect((await world.emails("booking_cancelled")).at(-1)?.body).not.toContain("can be used again");
  });

  it("can cancel any booking with a refund of their choosing", async () => {
    const booked = expectOk(await world.book({ date: NEAR })); // the customer would get nothing here
    const result = expectOk(await ownerCancelBooking(world.db, booked.ref, { refundCents: 17600 }, world.manageDeps()));
    expect(result).toEqual({ ok: true, refund: "sent", refundCents: 17600 });
    expect(await bookingRow(booked.ref)).toMatchObject({ status: "cancelled", cancelReason: "owner" });
    expect((await world.db.select().from(refunds))[0]).toMatchObject({ amountCents: 17600, automatic: false, status: "succeeded" });
    expect((await world.emails("booking_cancelled"))[0].body).toContain("A refund of $176 is on its way");
    expect((await world.emails("owner_refund_notice"))[0].body).toContain("A refund of $176 was sent");
  });

  it("tells the client the whole outcome when there is a card refund: the studio cancelled, the code works again, whom to ask", async () => {
    const promo = (await issuePromo(world.db, { kind: "percent", value: 10, source: "loyalty", email: "jane@example.com", expiresAt: daysAfter(NOW, 60) }))!;
    const booked = expectOk(await world.book({ date: FAR, promoCode: promo.code }));
    expectOk(await ownerCancelBooking(world.db, booked.ref, { refundCents: 2000 }, world.manageDeps()));
    const [mail] = await world.emails("booking_cancelled");
    expect(mail.body).toContain(`Your booking ${booked.ref} on`);
    expect(mail.body).toContain("has been cancelled by the studio.");
    expect(mail.body).toContain("A refund of $20 is on its way to your card.");
    expect(mail.body).toContain("The code you used for this booking can be used again.");
    expect(mail.body).toContain("Please contact us with any questions.");
  });

  it("puts the client's email right when the card refund does not go through", async () => {
    const booked = expectOk(await world.book({ date: NEAR }));
    world.failRefunds = "The card account is closed";
    expect(await ownerCancelBooking(world.db, booked.ref, { refundCents: 3000 }, world.manageDeps())).toMatchObject({ ok: true, refund: "pending" });
    const [mail] = await world.emails("booking_cancelled");
    expect(mail.body).toContain("A refund of $30 is due to your card, and has not reached it yet: the studio has been told, and will see that it does.");
    expect(mail.body).not.toContain("on its way");
    // The owner is told what to do, and not that the client was promised the money.
    const [alert] = await world.emails("owner_refund_failed");
    expect(alert.body).toContain("Refunded it in Square");
    expect(alert.body).not.toContain("told a refund is coming");
  });

  it("does not cancel on figures that changed since its page was drawn: a payment received, or a refund sent, meanwhile", async () => {
    const booked = expectOk(await world.book({ date: NEAR }));
    expect(await ownerCancelBooking(world.db, booked.ref, { refundCents: 0, seenCardCents: 0 }, world.manageDeps())).toMatchObject({
      ok: false,
      code: "changed",
      message: "The money on this booking changed after this page was opened: the card now holds $176. Look at it again, then cancel.",
    });
    expect((await bookingRow(booked.ref)).status).toBe("confirmed");
    // A refund sent from another window: the card holds less than the page showed.
    expectOk(await ownerRefund(world.db, booked.ref, { amountCents: 5000, reason: "" }, world.manageDeps()));
    expect(await ownerCancelBooking(world.db, booked.ref, { refundCents: 0, seenCardCents: 17600 }, world.manageDeps())).toMatchObject({
      ok: false,
      code: "changed",
      message: "The money on this booking changed after this page was opened: the card now holds $126. Look at it again, then cancel.",
    });
    expectOk(await ownerCancelBooking(world.db, booked.ref, { refundCents: 0, seenCardCents: 12600 }, world.manageDeps()));
  });

  it("cannot refund more than the card paid, or cancel twice", async () => {
    const booked = expectOk(await world.book({ date: NEAR }));
    expect(await ownerCancelBooking(world.db, booked.ref, { refundCents: 17601 }, world.manageDeps())).toMatchObject({
      ok: false,
      code: "bad_amount",
      message: "At most $176 can be refunded to the card for this booking.",
    });
    expect(await ownerCancelBooking(world.db, booked.ref, { refundCents: -1 }, world.manageDeps())).toMatchObject({ ok: false, code: "bad_amount" });
    expect(await ownerCancelBooking(world.db, booked.ref, { refundCents: 10.5 }, world.manageDeps())).toMatchObject({ ok: false, code: "bad_amount" });
    expect((await bookingRow(booked.ref)).status).toBe("confirmed");

    expect((await ownerCancelBooking(world.db, booked.ref, { refundCents: 0 }, world.manageDeps())).ok).toBe(true);
    expect(await ownerCancelBooking(world.db, booked.ref, { refundCents: 0 }, world.manageDeps())).toMatchObject({ ok: false, code: "not_cancellable" });
    expect(world.refundCalls).toHaveLength(0);
  });

  it("can refund part of a booking without cancelling it, and later refunds count what was already returned", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    const row = await bookingRow(booked.ref);
    expect(await ownerRefund(world.db, booked.ref, { amountCents: 5000, reason: "Broken light" }, world.manageDeps())).toEqual({
      ok: true,
      refund: "sent",
      refundCents: 5000,
    });
    expect((await bookingRow(booked.ref)).status).toBe("confirmed");
    expect(await netCardPaidCents(world.db, row.id)).toBe(12600);
    expect(world.refundCalls[0].reason).toBe("Broken light");

    expect(await ownerRefund(world.db, booked.ref, { amountCents: 12601, reason: "" }, world.manageDeps())).toMatchObject({ ok: false, code: "bad_amount" });
    expect(await ownerRefund(world.db, booked.ref, { amountCents: 0, reason: "" }, world.manageDeps())).toMatchObject({ ok: false, code: "bad_amount" });

    // The customer cancels early: the policy refund is based on what the card still holds.
    const cancelled = expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    expect(cancelled).toMatchObject({ refundCents: 12600 - 630, feeCents: 630 });
    const total = (await world.db.select().from(refunds)).reduce((sum, r) => sum + r.amountCents, 0);
    expect(total).toBe(5000 + 11970);
    expect((await world.db.select().from(payments))[0].refundedCents).toBe(16970);
  });
});

describe("test mode and the live account", () => {
  const live = (): PaymentProvider => ({ ...world.provider, name: "square" });
  const sandbox = (): PaymentProvider => ({ ...world.provider, name: "square-sandbox" });

  it("are never mixed in one database: the site refuses one that would mix them, and says what to do", async () => {
    // Test mode's booking: made, and paid, with the pretend processor.
    expectOk(await world.book({ date: FAR }));
    expect(await world.db.select({ kind: bookings.moneyKind }).from(bookings)).toEqual([{ kind: "test" }]);
    for (const processor of ["mock", "square-sandbox", null]) await expect(assertOneKindOfMoney(world.db, processor)).resolves.toBeUndefined();
    await expect(assertOneKindOfMoney(world.db, "square")).rejects.toThrow(LIVE_ON_TEST);
    // Cleared, it is ready for the live account.
    expect(await clearTestMode(world.db, NOW)).toMatchObject({ bookings: 1, keptBookings: 0 });
    await expect(assertOneKindOfMoney(world.db, "square")).resolves.toBeUndefined();
    // A booking of the live account is real money: test mode refuses it, and the clear never removes it.
    expectOk(await world.book({ date: FAR, startMinute: h(14) }, { payments: live() }));
    await expect(assertOneKindOfMoney(world.db, "mock")).rejects.toThrow(TEST_ON_LIVE);
    await expect(assertOneKindOfMoney(world.db, "square-sandbox")).rejects.toThrow(TEST_ON_LIVE);
    expect(await clearTestMode(world.db, NOW)).toMatchObject({ bookings: 0, keptBookings: 1 });
    expect(await world.db.select({ kind: bookings.moneyKind }).from(bookings)).toEqual([{ kind: "live" }]);
  });

  /**
   * Marks a booking as the other kind of money, to build what a site could leave behind before it refused a code or a
   * payment link of the other kind: the clear has to put such a database right all the same.
   */
  const markAs = (ref: string, kind: "test" | "live") => world.db.update(bookings).set({ moneyKind: kind }).where(eq(bookings.ref, ref));

  const adminBookingPaidInCash = async (owner: AuthUser, processor: string | null, start = h(10)) => {
    const made = expectOk(
      await createAdminBooking(
        world.db,
        owner,
        { studioIds: [world.ids.paris], date: FAR, startMinute: start, durationMinutes: 60, customer: { name: "Dana Diaz", email: "dana@example.com", phone: "407-555-0133" } },
        { now: NOW, baseUrl: "https://studio.test", processor },
      ),
    );
    expectOk(await recordStudioPayment(world.db, owner, made.ref, { amountCents: 2000, method: "cash", note: "" }, NOW));
    return made;
  };

  it("keeps what was booked with real money, cash taken at the studio included, whatever opens the database", async () => {
    const owner = await world.addUser("owner@studio.test", "owner", "Olivia");
    // Booked in the admin with the live account, and with no card processor set up: both real, both paid in cash.
    await adminBookingPaidInCash(owner, "square", h(10));
    await adminBookingPaidInCash(owner, null, h(13));
    expect((await world.db.select({ kind: bookings.moneyKind }).from(bookings)).map((row) => row.kind)).toEqual(["live", "live"]);
    // Test mode refuses the database, whichever opens it when: nothing makes these bookings test mode's afterwards.
    await expect(assertOneKindOfMoney(world.db, "square-sandbox")).rejects.toThrow(TEST_ON_LIVE);
    await expect(assertOneKindOfMoney(world.db, "mock")).rejects.toThrow(TEST_ON_LIVE);
    await expect(assertOneKindOfMoney(world.db, "square")).resolves.toBeUndefined();
    // The clear removes none of it.
    expect(await clearTestMode(world.db, NOW)).toMatchObject({ bookings: 0, keptBookings: 2 });
    expect(await world.db.select({ provider: payments.provider, amountCents: payments.amountCents }).from(payments)).toEqual([
      { provider: "manual", amountCents: 2000 },
      { provider: "manual", amountCents: 2000 },
    ]);
  });

  it("refuses the live account on a pretend booking paid in pretend cash", async () => {
    // With the live account, the pretend cash would become real credit.
    const owner = await world.addUser("owner@studio.test", "owner", "Olivia");
    await adminBookingPaidInCash(owner, "mock");
    expect(await world.db.select({ provider: payments.provider }).from(payments)).toEqual([{ provider: "manual" }]);
    await expect(assertOneKindOfMoney(world.db, "square")).rejects.toThrow(LIVE_ON_TEST);
  });

  it("gives a way out when a server still in test mode books beside the live account: the clear removes only what it made", async () => {
    // A code of the owners', which a real booking and a pretend one both used.
    const shared = (await issuePromo(world.db, { kind: "percent", value: 10, source: "manual", email: null, expiresAt: daysAfter(NOW, 90), maxUses: 2 }))!;
    // The live account books; a server left in test mode books beside it, after the live one opened the database.
    const real = expectOk(await world.book({ date: FAR, startMinute: h(9), durationMinutes: 60, promoCode: shared.code }, { payments: live() }));
    expectOk(await world.book({ date: FAR, startMinute: h(13), durationMinutes: 60, promoCode: shared.code }));
    expect((await world.db.select().from(promoCodes).where(eq(promoCodes.id, shared.id)))[0].usedCount).toBe(2);
    // The live account's next start refuses the database, and the overview of the one still running says why.
    await expect(assertOneKindOfMoney(world.db, "square")).rejects.toThrow(LIVE_ON_TEST);
    expect(await otherMoneyNotice(world.db, "square")).toContain("It left 1 booking made in test mode: none of it is real money.");
    // The clear removes test mode's booking and what it took of the code, and nothing else: the live account opens it.
    expect(await clearTestMode(world.db, NOW)).toMatchObject({ bookings: 1, keptBookings: 1 });
    await expect(assertOneKindOfMoney(world.db, "square")).resolves.toBeUndefined();
    expect(await world.db.select({ ref: bookings.ref }).from(bookings)).toEqual([{ ref: real.ref }]);
    expect(await world.db.select({ provider: payments.provider }).from(payments)).toEqual([{ provider: "square" }]);
    expect((await world.db.select().from(promoCodes).where(eq(promoCodes.id, shared.id)))[0].usedCount).toBe(1);
    expect(await otherMoneyNotice(world.db, "square")).toBeNull();
  });

  it("leaves what real bookings rely on: a test code they used, mail about them, and a shared code's uses", async () => {
    const shared = (await issuePromo(world.db, { kind: "percent", value: 10, source: "manual", email: null, expiresAt: daysAfter(NOW, 90), maxUses: 3 }))!;
    // A pretend booking moved for a reschedule code, which a real booking then spent.
    const moved = expectOk(await world.book({ date: FAR, startMinute: h(9), durationMinutes: 60 }));
    const moveCode = expectOk(await requestRescheduleCode(world.db, moved.ref, byToken(moved.manageToken), world.manageDeps())).code;
    await markAs(moved.ref, "live");
    const paidWithIt = expectOk(await world.book({ date: FAR, startMinute: h(11), durationMinutes: 60, promoCode: moveCode }, { payments: live() }));
    await markAs(moved.ref, "test");
    // A shared code of the owners': a pretend booking used it and was released for a reschedule code; a real one used it too.
    const released = expectOk(await world.book({ date: FAR, startMinute: h(13), durationMinutes: 60, promoCode: shared.code }));
    expectOk(await requestRescheduleCode(world.db, released.ref, byToken(released.manageToken), world.manageDeps()));
    const real = expectOk(await world.book({ date: FAR, startMinute: h(15), durationMinutes: 60, promoCode: shared.code }, { payments: live() }));
    expect((await world.db.select().from(promoCodes).where(eq(promoCodes.id, shared.id)))[0].usedCount).toBe(2);
    // A message that names a pretend booking and a real one is about the real one too.
    await queueEmail(world.db, { to: OWNER_EMAIL, kind: "owner_note", subject: `${moved.ref} and ${real.ref}`, body: "Both." });

    const cleared = await clearTestMode(world.db, NOW);
    expect(cleared).toMatchObject({ bookings: 2, keptBookings: 2, codes: 1 });
    // The reschedule code the real booking spent stays, named for the owners; the real booking keeps it.
    expect(cleared.keptCodes).toContainEqual(expect.objectContaining({ code: moveCode, issuedInTestMode: true }));
    expect(describeTestMode(cleared).join("\n")).toContain(`${moveCode}: `);
    expect((await bookingRow(paidWithIt.ref)).promoCodeId).not.toBeNull();
    // The released pretend booking's use of the shared code is given back; the real one's stays.
    expect((await world.db.select().from(promoCodes).where(eq(promoCodes.id, shared.id)))[0].usedCount).toBe(1);
    // Mail about the real bookings stays; mail about the pretend ones alone goes.
    const subjects = (await world.db.select({ subject: emailOutbox.subject }).from(emailOutbox)).map((row) => row.subject);
    expect(subjects).toContain(`Booking confirmed: ${paidWithIt.ref}`);
    expect(subjects).toContain(`Booking confirmed: ${real.ref}`);
    expect(subjects).toContain(`${moved.ref} and ${real.ref}`);
    expect(subjects).not.toContain(`Booking confirmed: ${moved.ref}`);
    expect(subjects).not.toContain(`Booking confirmed: ${released.ref}`);
  });

  it("keeps a real booking that a server in test mode took a pretend payment for: only what was pretend goes", async () => {
    const owner = await world.addUser("owner@studio.test", "owner", "Olivia");
    // A real booking, made in the admin with the live account, part paid in cash.
    const made = await adminBookingPaidInCash(owner, "square");
    const row = await bookingRow(made.ref);
    const rest = row.totalCents - 2000;
    // A server left in test mode emailed a payment link for the rest, and the client "paid" it on the pretend page.
    const pretend = { now: NOW, baseUrl: "https://studio.test", payments: world.provider };
    await markAs(made.ref, "test");
    expectOk(await sendPayLink(world.db, owner, made.ref, pretend));
    await markAs(made.ref, "live");
    const [link] = await world.db.select().from(paymentLinks);
    world.links[0].state = { state: "paid", paymentId: "mock_pay_1", amountCents: rest };
    expect(await checkPayLink(world.db, link.id, pretend)).toBe("paid");
    expect(await owedCents(world.db, row, NOW)).toBe(0);
    // The live account refuses the database, pretend money being in it, and its overview says what it is.
    await expect(assertOneKindOfMoney(world.db, "square")).rejects.toThrow(LIVE_ON_TEST);
    expect(await otherMoneyNotice(world.db, "square")).toContain("It left pretend payments or payment links for 1 real booking: none of it is real money.");

    const contents = await testModeContents(world.db, NOW);
    expect(contents).toMatchObject({ bookings: 0, keptBookings: 1, pretend: [{ ref: made.ref, payments: 1, cents: rest, links: 1 }] });
    const what = `1 card payment (${formatCents(rest)}) and 1 payment link`;
    expect(describeTestMode(contents).join("\n")).toContain(`${made.ref}, Dana Diaz: ${what}`);
    await clearTestMode(world.db, NOW);
    // The booking stays with its cash, owes the rest again, and its history says what was removed.
    expect(await world.db.select({ ref: bookings.ref }).from(bookings)).toEqual([{ ref: made.ref }]);
    expect(await world.db.select({ provider: payments.provider, amountCents: payments.amountCents }).from(payments)).toEqual([{ provider: "manual", amountCents: 2000 }]);
    expect(await world.db.select().from(paymentLinks)).toEqual([]);
    expect(await owedCents(world.db, row, NOW)).toBe(rest);
    const notes = (await world.db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, row.id))).map((event) => event.note);
    expect(notes).toContain(`Removed what test mode's card processor had recorded for this booking, no money having moved: ${what}`);
    await expect(assertOneKindOfMoney(world.db, "square")).resolves.toBeUndefined();
    expect(describeTestMode(await testModeContents(world.db, NOW))[0]).toBe("Nothing of test mode is in this database: there is nothing to remove.");
  });

  it("gives a real code back what a pretend booking took of it, also when that booking was cancelled without it", async () => {
    // Real credit: a booking of the live account, moved for a reschedule code worth $176.
    const real = expectOk(await world.book({ date: FAR, startMinute: h(9) }, { payments: live() }));
    const moved = expectOk(await requestRescheduleCode(world.db, real.ref, byToken(real.manageToken), world.manageDeps({ payments: live() })));
    const code = async () => (await world.db.select().from(promoCodes).where(eq(promoCodes.code, moved.code)))[0];
    expect(await code()).toMatchObject({ value: 17600, usedCount: 0 });
    // A server in test mode took a booking paid with it, which the client then cancelled: a moved booking is not refunded.
    const pretend = expectOk(await world.book({ date: FAR, startMinute: h(13), durationMinutes: 60, promoCode: moved.code }, { payments: live() }));
    await markAs(pretend.ref, "test");
    expectOk(await cancelBooking(world.db, pretend.ref, byToken(pretend.manageToken), world.manageDeps()));
    expect((await code()).value).toBeLessThan(17600);
    // The clear removes the pretend booking, and the real credit is whole again.
    expect(await clearTestMode(world.db, NOW)).toMatchObject({ bookings: 1, keptBookings: 1, codes: 0 });
    expect(await code()).toMatchObject({ value: 17600, usedCount: 0 });
  });

  it("numbers a customer's free hours anew when some of them go, so that the next one earned is still sent", async () => {
    const visit = expectOk(await world.book({ date: FAR }));
    const erin = { kind: "free_hour" as const, value: 60, source: "loyalty" as const, email: "erin@example.com", expiresAt: daysAfter(NOW, 90) };
    // Her first free hour came from visits of test mode; her second from stamps an owner added by hand.
    expect(await issuePromo(world.db, { ...erin, originBookingId: (await bookingRow(visit.ref)).id, loyaltySeq: 1 })).not.toBeNull();
    const second = (await issuePromo(world.db, { ...erin, loyaltySeq: 2 }))!;
    await clearTestMode(world.db, NOW);
    // The one that stays is her first now: the next she earns is her second, and is not refused as sent already.
    expect(await world.db.select({ id: promoCodes.id, seq: promoCodes.loyaltySeq }).from(promoCodes)).toEqual([{ id: second.id, seq: 1 }]);
    expect(await issuePromo(world.db, { ...erin, loyaltySeq: 2 })).not.toBeNull();
  });

  it("counts a booking made with no card processor set up as what the database holds: a setting wrong for a while changes nothing for good", async () => {
    const owner = await world.addUser("owner@studio.test", "owner", "Olivia");
    const kinds = async () => (await world.db.select({ kind: bookings.moneyKind }).from(bookings).orderBy(bookings.startAt)).map((row) => row.kind);
    // Square's sandbox takes a booking; then a deploy loses a key, and the owner books in the admin with no processor.
    expectOk(await world.book({ date: FAR, startMinute: h(9), durationMinutes: 60 }, { payments: sandbox() }));
    await adminBookingPaidInCash(owner, null, h(13));
    expect(await kinds()).toEqual(["test", "test"]);
    // The key is put back: the sandbox opens the database as before, and the live account still refuses it.
    await expect(assertOneKindOfMoney(world.db, "square-sandbox")).resolves.toBeUndefined();
    await expect(assertOneKindOfMoney(world.db, "square")).rejects.toThrow(LIVE_ON_TEST);
    // Where the bookings are real, one made with no processor is real, and test mode stays refused.
    await clearTestMode(world.db, NOW);
    await adminBookingPaidInCash(owner, "square", h(9));
    await adminBookingPaidInCash(owner, null, h(13));
    expect(await kinds()).toEqual(["live", "live"]);
    await expect(assertOneKindOfMoney(world.db, "square-sandbox")).rejects.toThrow(TEST_ON_LIVE);
  });

  it("counts the first booking of a database with no card processor as real on the live site, and as test mode's anywhere else", async () => {
    expect(await world.db.select().from(bookings)).toEqual([]);
    expect(await moneyKindNow(world.db, null)).toBe("test");
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(await moneyKindNow(world.db, null)).toBe("live");
      // A card processor says it by itself, wherever the site runs.
      expect(await moneyKindNow(world.db, "mock")).toBe("test");
      expect(await moneyKindNow(world.db, "square-sandbox")).toBe("test");
      expect(await moneyKindNow(world.db, "square")).toBe("live");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a code of the other kind of money than the booking: test mode's credit never pays for a real booking", async () => {
    // Credit of test mode: a pretend booking moved for a reschedule code.
    const pretend = expectOk(await world.book({ date: FAR, startMinute: h(9), durationMinutes: 60 }));
    const testCode = expectOk(await requestRescheduleCode(world.db, pretend.ref, byToken(pretend.manageToken), world.manageDeps())).code;
    const withTestCode = { date: FAR, startMinute: h(13), durationMinutes: 60, promoCode: testCode };
    const priced = { studioIds: [world.ids.blanche], date: FAR, durationMinutes: 60, addons: [], promoCode: testCode, email: "jane@example.com" };
    // With the live account it is refused, when the price is asked and when the booking is made.
    const notReal = { ok: false, code: "invalid_code", message: "That code was issued in test mode, when no money moved, so it cannot pay for a real booking." };
    expect(await quoteSelection(world.db, priced, NOW, "square")).toMatchObject(notReal);
    expect(await world.book(withTestCode, { payments: live() })).toMatchObject(notReal);
    // With card payments off for a while, a booking is what the database holds, test mode's here: the code pays, as
    // it does in test mode, and what it paid for goes with the rest of test mode.
    expect(await quoteSelection(world.db, priced, NOW, null)).toMatchObject({ ok: true });
    expect(await quoteSelection(world.db, priced, NOW, "mock")).toMatchObject({ ok: true });
    const paidWithIt = expectOk(await world.book(withTestCode, { payments: null }));
    expect((await bookingRow(paidWithIt.ref)).moneyKind).toBe("test");
    expect(await clearTestMode(world.db, NOW)).toMatchObject({ bookings: 2, keptBookings: 0, codes: 1 });
    expect(await world.db.select().from(promoCodes)).toEqual([]);

    // Real credit, on a site in test mode: it is not used up on a pretend booking.
    const real = expectOk(await world.book({ date: FAR, startMinute: h(9), durationMinutes: 60 }, { payments: live() }));
    const realCode = expectOk(await requestRescheduleCode(world.db, real.ref, byToken(real.manageToken), world.manageDeps({ payments: live() }))).code;
    expect(await world.book({ date: FAR, startMinute: h(13), durationMinutes: 60, promoCode: realCode })).toMatchObject({
      ok: false,
      code: "invalid_code",
      message: "That code is real credit, and this site is in test mode: it cannot be used here.",
    });
    // A code no booking issued, the owners' own, is used wherever it is entered.
    const own = (await issuePromo(world.db, { kind: "percent", value: 10, source: "manual", email: null, expiresAt: null, maxUses: 2 }))!;
    expectOk(await world.book({ date: FAR, startMinute: h(13), durationMinutes: 60, promoCode: own.code }, { payments: live() }));
  });

  it("keeps a booking made in test mode that the live account took money for, and counts it as real from then on", async () => {
    const owner = await world.addUser("owner@studio.test", "owner", "Olivia");
    // Made in the admin of a server in test mode, part paid in pretend cash. The live site then emailed a payment link
    // for the rest, as it could before it refused to, and the client paid it with a real card.
    const made = await adminBookingPaidInCash(owner, "mock");
    const row = await bookingRow(made.ref);
    const rest = row.totalCents - 2000;
    const real = { now: NOW, baseUrl: "https://studio.test", payments: live() };
    await markAs(made.ref, "live");
    expectOk(await sendPayLink(world.db, owner, made.ref, real));
    await markAs(made.ref, "test");
    const [link] = await world.db.select().from(paymentLinks);
    world.links[0].state = { state: "paid", paymentId: "sq_pay_1", amountCents: rest };
    expect(await checkPayLink(world.db, link.id, real)).toBe("paid");
    // A pretend booking beside it, which goes.
    const other = expectOk(await world.book({ date: FAR, startMinute: h(14), durationMinutes: 60 }));

    const contents = await testModeContents(world.db, NOW);
    expect(contents).toMatchObject({ bookings: 1, keptBookings: 1, madeReal: [{ ref: made.ref, cents: rest, byHandCents: 2000 }], pretend: [] });
    const words = describeTestMode(contents).join("\n");
    expect(words).toContain("Kept, and counted as real from now on: 1 booking made in test mode for which Square's live account took money, or made a payment link.");
    expect(words).toContain(`${made.ref}, Dana Diaz, `);
    expect(words).toContain(`: ${formatCents(rest)} taken by the live account, $20 recorded by hand, perhaps in test mode, which counts as real from now on: look at it`);
    await clearTestMode(world.db, NOW);
    // The record of the real payment stays, with its booking, which is real now; the pretend booking is gone.
    expect(await world.db.select({ ref: bookings.ref, kind: bookings.moneyKind }).from(bookings)).toEqual([{ ref: made.ref, kind: "live" }]);
    expect(await world.db.select({ provider: payments.provider, status: payments.status, amountCents: payments.amountCents }).from(payments).orderBy(payments.amountCents)).toEqual([
      { provider: "manual", status: "succeeded", amountCents: 2000 },
      { provider: "square", status: "succeeded", amountCents: rest },
    ]);
    const notes = (await world.db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, row.id))).map((event) => event.note);
    expect(notes).toContain("Made in test mode, and counted as a real booking from now on: Square's live account took money for it, or made a payment link for it");
    expect(await bookingRow(other.ref)).toBeUndefined();
    await expect(assertOneKindOfMoney(world.db, "square")).resolves.toBeUndefined();
  });

  it("removes a booking of test mode whose live payment link was withdrawn unpaid: no real money moved for it", async () => {
    const owner = await world.addUser("owner@studio.test", "owner", "Olivia");
    const made = await adminBookingPaidInCash(owner, "mock");
    // The live site emailed a link for it, as it could before it refused to, and withdrew it before it was paid.
    const real = { now: NOW, baseUrl: "https://studio.test", payments: live() };
    await markAs(made.ref, "live");
    expectOk(await sendPayLink(world.db, owner, made.ref, real));
    expectOk(await cancelPayLink(world.db, owner, made.ref, real));
    await markAs(made.ref, "test");
    expect(await world.db.select({ provider: paymentLinks.provider, status: paymentLinks.status }).from(paymentLinks)).toEqual([{ provider: "square", status: "cancelled" }]);
    expect(await testModeContents(world.db, NOW)).toMatchObject({ bookings: 1, madeReal: [] });
    await clearTestMode(world.db, NOW);
    expect(await world.db.select().from(bookings)).toEqual([]);
    expect(await world.db.select().from(paymentLinks)).toEqual([]);
  });

  it("makes a payment link only where the card processor moves the booking's own kind of money", () => {
    expect(payLinkPossible("square", "live")).toBe(true);
    expect(payLinkPossible("mock", "test")).toBe(true);
    expect(payLinkPossible("square-sandbox", "test")).toBe(true);
    expect(payLinkPossible("square", "test")).toBe(false);
    expect(payLinkPossible("mock", "live")).toBe(false);
    expect(payLinkPossible(null, "live")).toBe(false);
  });

  it("names a free hour of a client whose visits of test mode go: it may not have been earned", async () => {
    // Four visits in test mode and a fifth with the live account earned Jane a free hour, which the real visit completed.
    const visit = expectOk(await world.book({ date: FAR, startMinute: h(9), durationMinutes: 60 }));
    await world.db.update(bookings).set({ status: "completed" }).where(eq(bookings.ref, visit.ref));
    const fifth = expectOk(await world.book({ date: FAR, startMinute: h(13), durationMinutes: 60 }, { payments: live() }));
    const freeHour = (await issuePromo(world.db, {
      kind: "free_hour",
      value: 60,
      source: "loyalty",
      email: "jane@example.com",
      expiresAt: daysAfter(NOW, 90),
      originBookingId: (await bookingRow(fifth.ref)).id,
      loyaltySeq: 1,
    }))!;
    const contents = await testModeContents(world.db, NOW);
    expect(contents.keptCodes).toEqual([expect.objectContaining({ code: freeHour.code, earnedWithTestVisits: true, issuedInTestMode: false, givenBack: false })]);
    const words = describeTestMode(contents).join("\n");
    expect(words).toContain("Kept: 1 code that test mode's bookings used, issued or helped to earn. Look at each, under Codes:");
    expect(words).toContain(`${freeHour.code}: a free hour, for jane@example.com`);
    expect(words).toContain("sent to a client whose visits of test mode go: it may not have been earned");
    // It stays: it is the owners' to cancel.
    await clearTestMode(world.db, NOW);
    expect(await world.db.select({ code: promoCodes.code }).from(promoCodes)).toEqual([{ code: freeHour.code }]);
  });

  it("says what clearing would remove and keep before anything is removed, naming what the owners should look at", async () => {
    const owner = await world.addUser("owner@studio.test", "owner", "Olivia");
    const booked = expectOk(await world.book({ date: FAR }));
    await adminBookingPaidInCash(owner, "mock", h(14));
    // The owners' own code, and five stamps carried over by hand, which send a free hour at once.
    const own = (await issuePromo(world.db, { kind: "percent", value: 10, source: "manual", email: "jane@example.com", expiresAt: null }))!;
    expectOk(await adjustStamps(world.db, owner, { email: "frank@example.com", stamps: 5, reason: "Carried over from the old card" }, { now: NOW, baseUrl: "https://studio.test" }));
    const [freeHour] = await world.db.select().from(promoCodes).where(eq(promoCodes.source, "loyalty"));
    expect(freeHour).toMatchObject({ email: "frank@example.com", originBookingId: null });

    const contents = await testModeContents(world.db, NOW);
    expect(contents).toMatchObject({ bookings: 2, keptBookings: 0, cardPayments: 1, byHand: { count: 1, cents: 2000 } });
    const words = describeTestMode(contents).join("\n");
    expect(words).toContain("Removed: 2 bookings made in test mode, and their history, whatever became of them.");
    expect(words).toContain("2 bookings of them still to come");
    expect(words).toContain(booked.ref);
    expect(words).toContain("Removed: their 1 payment recorded by hand, $20 in all.");
    expect(words).toContain("Kept, as real: 2 codes. Cancel any that was only a try, under Codes:");
    expect(words).toContain(`${own.code}: 10% off, for jane@example.com`);
    expect(words).toContain(`${freeHour.code}: a free hour, for frank@example.com`);
    expect(words).toContain("frank@example.com: +5, Carried over from the old card, /admin/customers/frank%40example.com");
    expect(words).toContain("Kept: the website");
    // Nothing was changed.
    expect(await world.db.select().from(bookings)).toHaveLength(2);
    // Cleared, there is nothing left to remove; one booking reads as one.
    await clearTestMode(world.db, NOW);
    expect(describeTestMode(await testModeContents(world.db, NOW))[0]).toBe("Nothing of test mode is in this database: there is nothing to remove.");
    expectOk(await world.book({ date: FAR }));
    expect(describeTestMode(await testModeContents(world.db, NOW))[0]).toBe("Removed: 1 booking made in test mode, and its history, whatever became of it.");
  });

  it("is cleared of test mode's bookings and what they made, keeping what the owners set up and giving their codes back", async () => {
    const owner = await world.addUser("owner@studio.test", "owner", "Olivia");
    const studiosBefore = await world.db.select().from(studios);
    await world.db.insert(settings).values({ key: "minLeadHours", value: 48 });
    // The owners' own code, spent on a booking of test mode.
    const own = (await issuePromo(world.db, { kind: "amount", value: 3000, source: "manual", email: null, expiresAt: daysAfter(NOW, 90) }))!;
    const spent = expectOk(await world.book({ date: FAR, startMinute: h(9), durationMinutes: 60, promoCode: own.code }));
    expect((await world.db.select().from(promoCodes).where(eq(promoCodes.id, own.id)))[0]).toMatchObject({ value: 0, usedCount: 1 });
    // A booking moved for a reschedule code, one cancelled with a refund, one made in the admin with a link and cash.
    const moved = expectOk(await world.book({ date: FAR, startMinute: h(11), durationMinutes: 60 }));
    expectOk(await requestRescheduleCode(world.db, moved.ref, byToken(moved.manageToken), world.manageDeps()));
    const cancelled = expectOk(await world.book({ date: FAR, startMinute: h(14), durationMinutes: 60 }));
    expectOk(await cancelBooking(world.db, cancelled.ref, byToken(cancelled.manageToken), world.manageDeps()));
    const made = await adminBookingPaidInCash(owner, "mock");
    expectOk(await sendPayLink(world.db, owner, made.ref, { now: NOW, baseUrl: "https://studio.test", payments: world.provider }));
    // A free hour a test visit earned, cancelled by an owner; stamps carried over by hand, which send one at once.
    const earned = (await issuePromo(world.db, {
      kind: "free_hour",
      value: 60,
      source: "loyalty",
      email: "erin@example.com",
      expiresAt: daysAfter(NOW, 90),
      originBookingId: (await bookingRow(spent.ref)).id,
    }))!;
    expectOk(await cancelReward(world.db, owner, earned.id, "A try", NOW));
    expectOk(await adjustStamps(world.db, owner, { email: "frank@example.com", stamps: 5, reason: "Carried over from the old card" }, { now: NOW, baseUrl: "https://studio.test" }));
    // A visitor's message and a sign-in code.
    await queueEmail(world.db, contactMessageEmail({ to: OWNER_EMAIL, name: "Gina", email: "gina@example.com", topic: "Studio rental", message: "Is Paris free in May?" }));
    await queueEmail(world.db, loginCodeEmail("gina@example.com", "123456", 10));

    // The listing gives the owners' code what it will be worth: all of it, the pretend booking's $30 given back.
    expect((await world.db.select().from(promoCodes).where(eq(promoCodes.id, own.id)))[0].value).toBe(0);
    expect((await testModeContents(world.db, NOW)).keptCodes).toContainEqual(expect.objectContaining({ code: own.code, value: 3000, givenBack: true }));
    const cleared = await clearTestMode(world.db, NOW);
    expect(cleared).toMatchObject({ bookings: 4, stampCorrections: [{ email: "frank@example.com", stamps: 5 }] });
    for (const table of [bookings, payments, refunds, paymentLinks, bookingEvents]) expect(await world.db.select().from(table)).toEqual([]);
    expect(await world.db.select().from(studioHolds)).toEqual([]);
    // The owners' code is left with its use and amount given back, and the free hour the stamps sent, with them.
    const codes = await world.db.select().from(promoCodes).orderBy(promoCodes.source);
    expect(codes).toMatchObject([
      { source: "loyalty", email: "frank@example.com", originBookingId: null },
      { id: own.id, value: 3000, usedCount: 0 },
    ]);
    // The owners' change of stamps stays; the entry about the reward goes with its code.
    expect(await world.db.select({ kind: loyaltyLedger.kind, email: loyaltyLedger.email }).from(loyaltyLedger)).toEqual([{ kind: "stamps", email: "frank@example.com" }]);
    // Mail about the bookings goes; the visitor's message, the sign-in code and the free hour's email stay.
    expect((await world.db.select({ kind: emailOutbox.kind }).from(emailOutbox)).map((row) => row.kind).sort()).toEqual(["contact_message", "login_code", "loyalty_code"]);
    // What the owners set up stays.
    expect(await world.db.select().from(studios)).toEqual(studiosBefore);
    expect(await world.db.select().from(settings).where(eq(settings.key, "minLeadHours"))).toMatchObject([{ value: 48 }]);
    expect(await world.db.select().from(users).where(eq(users.id, owner.id))).toHaveLength(1);
  });

  it("relabels the sandbox's payments recorded before it had a name of its own, and marks each booking by its money (migration 0028)", async () => {
    const early = expectOk(await world.book({ date: FAR, startMinute: h(9), durationMinutes: 60 }));
    const later = expectOk(await world.book({ date: FAR, startMinute: h(13), durationMinutes: 60 }));
    // As the site recorded them: the sandbox's payment as "square" until 09:27 New York on 2026-11-17, the live account's after.
    const idOf = async (ref: string) => (await bookingRow(ref)).id;
    await world.db.update(payments).set({ provider: "square", createdAt: new Date("2026-11-16T12:00:00Z") }).where(eq(payments.bookingId, await idOf(early.ref)));
    await world.db.update(payments).set({ provider: "square", createdAt: new Date("2026-11-17T15:00:00Z") }).where(eq(payments.bookingId, await idOf(later.ref)));
    const statements = readFileSync(path.join(process.cwd(), "drizzle", "0028_booking_money_kind.sql"), "utf8")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => /UPDATE "/.test(statement));
    expect(statements).toHaveLength(3);
    for (const statement of statements) await world.db.execute(sql.raw(statement));
    const rows = await world.db
      .select({ ref: bookings.ref, kind: bookings.moneyKind, provider: payments.provider })
      .from(bookings)
      .innerJoin(payments, eq(payments.bookingId, bookings.id))
      .orderBy(bookings.startAt);
    expect(rows).toEqual([
      { ref: early.ref, kind: "test", provider: "square-sandbox" },
      { ref: later.ref, kind: "live", provider: "square" },
    ]);
  });

  it("leaves a refund of the other Square account's payment waiting, says why, and tells the owner once", async () => {
    // Paid through the live account; then the sandbox is set up by mistake for a while.
    const booked = expectOk(await world.book({ date: FAR }, { payments: live() }));
    const cancelled = expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps({ payments: sandbox() })));
    expect(cancelled.refund).toBe("waiting");
    expect(world.refundCalls).toEqual([]);
    // The client is told it has not reached their card, and not that it is tried again: it is not, until that processor is back.
    const [told] = await world.emails("booking_cancelled");
    expect(told.body).toContain("has not reached it yet: the studio has been told, and will see that it does.");
    expect(told.body).not.toContain("tried again");
    const waiting =
      "Its payment was taken through another card processor, or Square account, than the one set up now, so the refund waits: it is sent once that one is set up again.";
    expect((await world.db.select().from(refunds))[0]).toMatchObject({ status: "pending", error: waiting });
    expect((await listRefundProblems(world.db))[0]).toMatchObject({ status: "pending", error: waiting });
    expect(await retryOpenRefunds(world.db, world.manageDeps({ payments: sandbox() }))).toEqual({ succeeded: 0, failed: 0 });
    expect(world.refundCalls).toEqual([]);
    const notices = await world.emails("owner_refund_waiting");
    expect(notices).toHaveLength(1);
    expect(notices[0].body).toContain(waiting);
    // With no processor at all, the same, in its own words, and the owner is told that too.
    expect(await processRefund(world.db, (await world.db.select().from(refunds))[0].id, world.manageDeps({ payments: null }))).toBe("waiting");
    expect((await world.db.select().from(refunds))[0].error).toBe("No card processor is set up now, so the refund waits: it is sent once one is.");
    expect(await world.emails("owner_refund_waiting")).toHaveLength(2);
    // The live account set up again: the refund goes through.
    expect(await retryOpenRefunds(world.db, world.manageDeps({ payments: live() }))).toEqual({ succeeded: 1, failed: 0 });
    expect((await world.db.select().from(refunds))[0]).toMatchObject({ status: "succeeded", error: null });
  });

  it("leaves an amount the other Square account reserved untouched, to be taken once that account is back", async () => {
    const booked = expectOk(await world.book({ date: FAR }, { payments: live() }));
    await world.db.update(payments).set({ status: "authorized" }).where(eq(payments.bookingId, (await bookingRow(booked.ref)).id));
    const [captures, releases] = [[...world.captures], [...world.releases]];
    expect(await settleReservedPayments(world.db, { now: NOW, payments: sandbox(), ownerEmail: null })).toEqual({ taken: 0, released: 0 });
    expect(world.captures).toEqual(captures);
    expect(world.releases).toEqual(releases);
    expect((await world.db.select().from(payments))[0]).toMatchObject({ status: "authorized" });
    expect(await settleReservedPayments(world.db, { now: NOW, payments: live(), ownerEmail: null })).toEqual({ taken: 1, released: 0 });
  });
});

describe("an amount reserved on a card that lapsed before it was taken", () => {
  it("is no longer taken, is told to the owner, and leaves the booking owing its price, which the studio records", async () => {
    world.failCaptures = "Square did not answer";
    const booked = expectOk(await world.book({ date: FAR })); // $176 reserved; taking it did not go through
    world.failCaptures = null;
    const row = await bookingRow(booked.ref);
    expect((await world.db.select().from(payments))[0]).toMatchObject({ status: "authorized" });
    // Within the day the card holds it: nothing is owed, and the summaries say it is held on the card, not charged.
    expect(await owedCents(world.db, row, hoursAfter(NOW, 23))).toBe(0);
    expect((await toBookingViews(world.db, [row], hoursAfter(NOW, 23)))[0]).toMatchObject({ dueCents: 0, heldCents: 17600, receivedCents: 0 });
    const held = await moneyOf(world.db, row, hoursAfter(NOW, 23));
    const reservedAt = (await world.db.select().from(payments))[0].createdAt;
    expect(held).toMatchObject({ dueCents: 0, receivedCents: 0, held: { cents: 17600, until: hoursAfter(reservedAt, 24).toISOString(), provider: "mock" } });
    expect(held.payments).toMatchObject([{ held: true, how: "Card, online: held on the card, not taken yet" }]);
    // After it, the card holds nothing: the booking owes its price, before and after the scheduled task sees it.
    const later = hoursAfter(NOW, 25);
    expect(await owedCents(world.db, row, later)).toBe(17600);
    const captures = [...world.captures];
    expect(await settleReservedPayments(world.db, { now: later, payments: world.provider, ownerEmail: OWNER_EMAIL })).toEqual({ taken: 0, released: 0 });
    expect(world.captures).toEqual(captures);
    expect((await world.db.select().from(payments))[0]).toMatchObject({
      status: "failed",
      error: "The amount reserved lapsed before it was taken: the card was not charged.",
    });
    const notes = (await world.db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, row.id))).map((event) => event.note);
    expect(notes).toContain("The $176 reserved on the card lapsed before it was taken: the card was not charged");
    // The owner is told what is still to pay, and so is the client, whose card was not charged.
    const [notice] = await world.emails("owner_reservation_lapsed");
    expect(notice.body).toContain("$176 is still to pay");
    const [toClient] = await world.emails("reservation_lapsed");
    expect(toClient).toMatchObject({ toEmail: row.customerEmail, subject: `Booking ${booked.ref}: your card was not charged` });
    expect(toClient.body).toContain("Nothing else about your booking changes, and $176 is still to pay.");
    expect((await toBookingViews(world.db, [row], later))[0]).toMatchObject({ dueCents: 17600, heldCents: 0 });
    expect((await moneyOf(world.db, row, later)).held).toBeNull();
    // The studio collects it, records it, and the booking is paid.
    const owner = await world.addUser("owner@studio.test", "owner", "Olivia");
    expectOk(await recordStudioPayment(world.db, owner, booked.ref, { amountCents: 17600, method: "cash", note: "" }, later));
    expect(await moneyOf(world.db, row, later)).toMatchObject({ receivedCents: 17600, dueCents: 0, madeInAdmin: false });
  });

  it("tells nobody to collect a booking the studio was paid for before the scheduled task saw the lapse", async () => {
    world.failCaptures = "Square did not answer";
    const booked = expectOk(await world.book({ date: FAR }));
    world.failCaptures = null;
    const later = hoursAfter(NOW, 25);
    // The appointment's page showed it owing as soon as the day was over, and the studio took it in cash.
    const owner = await world.addUser("owner@studio.test", "owner", "Olivia");
    expectOk(await recordStudioPayment(world.db, owner, booked.ref, { amountCents: 17600, method: "cash", note: "" }, later));
    expect(await settleReservedPayments(world.db, { now: hoursAfter(NOW, 26), payments: world.provider, ownerEmail: OWNER_EMAIL })).toEqual({ taken: 0, released: 0 });
    // The lapse is written into the history, and nobody is asked to collect money that came in.
    const row = await bookingRow(booked.ref);
    const notes = (await world.db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, row.id))).map((event) => event.note);
    expect(notes).toContain("The $176 reserved on the card lapsed before it was taken: the card was not charged");
    expect(await world.emails("owner_reservation_lapsed")).toEqual([]);
    expect(await world.emails("reservation_lapsed")).toEqual([]);
  });

  it("tells nobody about the lapse of a booking cancelled after the scheduled task found its payment", async () => {
    world.failCaptures = "Square did not answer";
    const booked = expectOk(await world.book({ date: FAR }));
    world.failCaptures = null;
    const row = await bookingRow(booked.ref);
    const [payment] = await world.db.select().from(payments);
    // The task found the payment while the booking stood; the client cancelled before the lapse was recorded.
    const found = { id: payment.id, amountCents: payment.amountCents, ref: row.ref, customer: row.customerName, customerEmail: row.customerEmail, bookingId: row.id, startAt: row.startAt };
    expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    await lapseReserved(world.db, found, { now: hoursAfter(NOW, 25), payments: world.provider, ownerEmail: OWNER_EMAIL });
    expect((await world.db.select().from(payments))[0].status).toBe("failed");
    expect(await world.emails("owner_reservation_lapsed")).toEqual([]);
    expect(await world.emails("reservation_lapsed")).toEqual([]);
  });

  it("tells a client whose card only holds the amount what cancelling or moving does with it", async () => {
    world.failCaptures = "Square did not answer";
    const booked = expectOk(await world.book({ date: FAR }));
    world.failCaptures = null;
    const soon = hoursAfter(NOW, 1);
    const choices = (await getManageChoices(world.db, booked.ref, byToken(booked.manageToken), soon))!;
    expect(choices.cancel.text).toBe("Nothing was charged to your card for this booking, so there is nothing to refund: the $176 it holds for it is released.");
    expect(choices.reschedule.text).toBe(
      "Nothing was charged for this booking yet: the $176 your card holds for it has not been taken, so there is no credit to move. You can cancel it, which releases that amount, and book again.",
    );
    // Moving is refused in the same words; cancelling says what the client was shown, and so does the email.
    expect(await requestRescheduleCode(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps({ now: soon }))).toMatchObject({
      ok: false,
      code: "nothing_paid",
      message: choices.reschedule.text,
    });
    const cancelled = expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps({ now: soon }), choices.cancel.text));
    expect(cancelled.message).toContain("the $176 it holds for it is released");
    const [mail] = await world.emails("booking_cancelled");
    expect(mail.body).toContain("the $176 it holds for it is released");
  });
});

describe("a client's change of a booking that stopped being confirmed while their page was open", () => {
  it("is refused with what became of the booking", async () => {
    const moved = expectOk(await world.book({ date: FAR }));
    expectOk(await requestRescheduleCode(world.db, moved.ref, byToken(moved.manageToken), world.manageDeps()));
    expect(await cancelBooking(world.db, moved.ref, byToken(moved.manageToken), world.manageDeps())).toMatchObject({
      ok: false,
      code: "not_confirmed",
      message: "This booking was released for a reschedule code meanwhile, so nothing more was done. Reload the page to see it as it is now.",
    });

    const missed = expectOk(await world.book({ date: FAR, startMinute: h(14), durationMinutes: 60 }));
    await world.db.update(bookings).set({ status: "no_show" }).where(eq(bookings.ref, missed.ref));
    expect(await requestRescheduleCode(world.db, missed.ref, byToken(missed.manageToken), world.manageDeps())).toMatchObject({
      ok: false,
      code: "not_confirmed",
      message: "This booking was marked as missed, so it can no longer be changed online. Please call the studio.",
    });
    await world.db.update(bookings).set({ status: "completed" }).where(eq(bookings.ref, missed.ref));
    expect(await cancelBooking(world.db, missed.ref, byToken(missed.manageToken), world.manageDeps())).toMatchObject({
      ok: false,
      code: "not_confirmed",
      message: "This visit has taken place, so the booking can no longer be changed online.",
    });
  });
});
