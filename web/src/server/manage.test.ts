import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookings, payments, promoCodes, refunds, settings, studioHolds } from "@/db/schema";
import {
  cancelBooking,
  cancelOutcomeText,
  getManageChoices,
  getManageOptions,
  netCardPaidCents,
  ownerCancelBooking,
  ownerRefund,
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
