import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookingEvents, bookings, emailOutbox, payments, promoCodes, refunds, settings, studioHolds } from "@/db/schema";
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
import { DEFAULT_SETTINGS } from "./settings";
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
      "A refund of $167.20 is due to your card ($8.80 processing fee kept), and has not reached it yet: it is tried again by itself, and the studio has been told.",
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
      `About your cancelled booking ${booked.ref}: A refund of $167.20 is due to your card ($8.80 processing fee kept), and has not reached it yet: it is tried again by itself, and the studio has been told.`,
    );
  });

  it("inside 14 days: cancels without a refund and says why", async () => {
    const booked = expectOk(await world.book({ date: NEAR }));
    const result = expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    expect(result).toMatchObject({ refundCents: 0, refund: "none" });
    expect(result.message).toBe("No refund is due, because the booking starts in less than 14 days.");
    expect(world.refundCalls).toHaveLength(0);
    expect(await world.db.select().from(refunds)).toHaveLength(0);
    expect((await bookingRow(booked.ref)).status).toBe("cancelled");
    expect((await world.emails("booking_cancelled"))[0].body).toContain("No refund is due");
    expect(await world.emails("owner_refund_notice")).toHaveLength(0);
  });

  it("draws the line at 14 days, not at 7 (the owner's answer of 2026-11-15)", async () => {
    // Ten days ahead was refunded while the window was 7 days. It no longer is.
    const tenDays = expectOk(await world.book({ date: "2026-11-24" }));
    expect(expectOk(await cancelBooking(world.db, tenDays.ref, byToken(tenDays.manageToken), world.manageDeps()))).toMatchObject({
      refundCents: 0,
      refund: "none",
    });
    // Exactly 14 days before the start is still in time: Saturday 10:00 for a booking on Saturday the 28th at 10:00.
    const onTheLine = expectOk(await world.book({ date: "2026-11-28" }));
    expect(expectOk(await cancelBooking(world.db, onTheLine.ref, byToken(onTheLine.manageToken), world.manageDeps()))).toMatchObject({
      refundCents: 17600 - 880,
      feeCents: 880,
      refund: "sent",
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
    expect(text(168)).toBe("No refund is due, because the booking starts in less than 7 days.");
    expect(text(100)).toBe("No refund is due, because the booking starts in less than 100 hours.");
    expect(text(36)).toBe("No refund is due, because the booking starts in less than 36 hours.");
    expect(text(1)).toBe("No refund is due, because the booking starts in less than 1 hour.");
  });

  it("tells the customer in advance what cancelling or moving would do", async () => {
    const early = expectOk(await world.book({ date: FAR }));
    expect(await getManageOptions(world.db, early.ref, byToken(early.manageToken), NOW)).toEqual({
      cancel: { allowed: true, refundCents: 16720, feeCents: 880, creditCents: 0, byHandCents: 0, why: "refund" },
      reschedule: { allowed: true, creditCents: 17600, discountCents: 0 },
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

  it("records the refund as pending when no processor is configured, and sends it later", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    const result = expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps({ payments: null })));
    expect(result.refund).toBe("pending");
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
      text: "This booking will be released and you will get a code worth $176, valid for 90 days, to book a new time. That is what you paid plus the $17.60 your discount code took off. A booking made with the code cannot be refunded.",
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

  it("books the new time for free, and that booking can no longer be refunded or moved", async () => {
    const first = expectOk(await world.book({ date: NEAR }));
    const { code } = expectOk(await requestRescheduleCode(world.db, first.ref, byToken(first.manageToken), world.manageDeps()));

    // The freed slot can be taken by the same customer at a new date, paying nothing.
    const second = expectOk(await world.book({ date: FAR, promoCode: code, paymentToken: undefined }));
    expect(second.totalCents).toBe(0);
    expect(world.charges).toHaveLength(1); // only the original payment
    expect(await bookingRow(second.ref)).toMatchObject({ rescheduledCount: 1, creditAppliedCents: 17600 });

    // 25 days ahead would normally be refundable. A moved booking is not.
    expect(await getManageOptions(world.db, second.ref, byToken(second.manageToken), NOW)).toEqual({
      cancel: { allowed: true, refundCents: 0, feeCents: 0, creditCents: 0, byHandCents: 0, why: "rescheduled" },
      reschedule: { allowed: false, reason: "limit_reached" },
    });
    expect(await requestRescheduleCode(world.db, second.ref, byToken(second.manageToken), world.manageDeps())).toMatchObject({
      ok: false,
      code: "limit_reached",
    });
    const cancelled = expectOk(await cancelBooking(world.db, second.ref, byToken(second.manageToken), world.manageDeps()));
    expect(cancelled).toMatchObject({ refundCents: 0, refund: "none" });
    expect(cancelled.message).toBe("No refund is due, because this booking was made with a reschedule code.");
    expect(world.refundCalls).toHaveLength(0);
  });

  it("charges only the difference for a dearer time and carries the whole value if moved again", async () => {
    await world.db.insert(settings).values({ key: "maxReschedules", value: 2 });
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

    await world.db.insert(settings).values({ key: "rescheduleCutoffHours", value: 2 });
    expect((await requestRescheduleCode(world.db, booked.ref, byToken(booked.manageToken), late)).ok).toBe(true);
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
    expectOk(await ownerRefund(world.db, booked.ref, { amountCents: 8800, reason: "" }, world.manageDeps()));
    expect((await world.db.select().from(promoCodes).where(eq(promoCodes.id, code.id)))[0].value).toBe(0);
    expect(await ownerRefund(world.db, booked.ref, { amountCents: 100, reason: "" }, world.manageDeps())).toMatchObject({ ok: false, code: "bad_amount" });
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
    expect(mail.body).toContain("A refund of $30 is due to your card, and has not reached it yet: it is tried again by itself, and the studio has been told.");
    expect(mail.body).not.toContain("on its way");
    // The owner is told what to do, and not that the client was promised the money.
    const [alert] = await world.emails("owner_refund_failed");
    expect(alert.body).toContain("Refunded it in Square");
    expect(alert.body).not.toContain("told a refund is coming");
  });

  it("does not cancel on figures that changed since its page was drawn, a payment received meanwhile", async () => {
    const booked = expectOk(await world.book({ date: NEAR }));
    expect(await ownerCancelBooking(world.db, booked.ref, { refundCents: 0, seenCardCents: 0 }, world.manageDeps())).toMatchObject({
      ok: false,
      code: "changed",
      message: "Money was received for this booking after this page was opened: the card now holds $176. Look at it again, then cancel.",
    });
    expect((await bookingRow(booked.ref)).status).toBe("confirmed");
    expectOk(await ownerCancelBooking(world.db, booked.ref, { refundCents: 0, seenCardCents: 17600 }, world.manageDeps()));
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
