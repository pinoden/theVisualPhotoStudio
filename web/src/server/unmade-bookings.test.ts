import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookings, payments, promoCodes, studioHolds } from "@/db/schema";
import { releaseExpiredHolds } from "./availability";
import { MOCK_TOKEN_DECLINED, type PaymentProvider } from "./payments";
import { issuePromo } from "./promos";
import { settleReservedPayments } from "./reserved";
import { createTestWorld, daysAfter, FAR, h, minutesAfter, NOW, type TestWorld } from "./testing";

/**
 * A booking that was never made gives back the code it spent: when its card
 * is refused, and when its hold on the time runs out before it was paid (the
 * server stopped while the card was answering). The two happening at once
 * give it back once, and a card that answers after the time was given up is
 * not charged.
 */
let world: TestWorld;

beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(() => world.reset());

const dana = { name: "Dana Diaz", email: "dana@example.com", phone: "407-555-0133" };
const LATER = minutesAfter(NOW, 30);

async function credit(cents: number) {
  return (await issuePromo(world.db, { kind: "amount", value: cents, source: "manual", email: dana.email, expiresAt: daysAfter(NOW, 90) }))!;
}

const codeNow = async (id: string) => (await world.db.select().from(promoCodes).where(eq(promoCodes.id, id)))[0];
const onlyBooking = async () => (await world.db.select().from(bookings))[0];

/** The recording processor, with something happening while the card is answering. */
function whileCharging(meanwhile: () => Promise<unknown>): PaymentProvider {
  return {
    ...world.provider,
    charge: async (request) => {
      await meanwhile();
      return world.provider.charge(request);
    },
  };
}

const booking = (promoCode: string, overrides = {}) => ({ date: FAR, startMinute: h(10), durationMinutes: 60, promoCode, customer: dana, ...overrides });

describe("a booking that was never made", () => {
  it("gives its studio credit back when its hold runs out", async () => {
    const code = await credit(3000);
    // The server stops while the card is answering: the booking waits for its payment, with the credit spent.
    const stopped = whileCharging(async () => {
      throw new Error("The server stopped");
    });
    await expect(world.book(booking(code.code), { payments: stopped })).rejects.toThrow("The server stopped");
    expect(await onlyBooking()).toMatchObject({ status: "pending_payment" });
    expect(await codeNow(code.id)).toMatchObject({ value: 0, usedCount: 1 });

    // Its hold has not run out yet: nothing changes.
    expect(await releaseExpiredHolds(world.db, NOW)).toBe(0);
    expect(await codeNow(code.id)).toMatchObject({ value: 0, usedCount: 1 });

    expect(await releaseExpiredHolds(world.db, LATER)).toBe(1);
    expect(await onlyBooking()).toMatchObject({ status: "expired" });
    expect(await codeNow(code.id)).toMatchObject({ value: 3000, usedCount: 0 });
    expect((await world.db.select().from(studioHolds)).every((hold) => !hold.active)).toBe(true);
    // Running out again gives nothing more.
    expect(await releaseExpiredHolds(world.db, minutesAfter(LATER, 30))).toBe(0);
    expect(await codeNow(code.id)).toMatchObject({ value: 3000, usedCount: 0 });
  });

  it("gives a discount code its use back when its hold runs out", async () => {
    const code = (await issuePromo(world.db, { kind: "percent", value: 10, source: "manual", email: null, expiresAt: daysAfter(NOW, 90), maxUses: 1 }))!;
    const stopped = whileCharging(async () => {
      throw new Error("The server stopped");
    });
    await expect(world.book(booking(code.code), { payments: stopped })).rejects.toThrow();
    expect(await codeNow(code.id)).toMatchObject({ usedCount: 1 });
    await releaseExpiredHolds(world.db, LATER);
    expect(await codeNow(code.id)).toMatchObject({ value: 10, usedCount: 0 });
    // And it can be used again.
    expect((await world.book(booking(code.code, { startMinute: h(14) }))).ok).toBe(true);
  });

  it("gives the code back once when the card is refused after the hold ran out", async () => {
    const code = await credit(3000);
    const slow = whileCharging(() => releaseExpiredHolds(world.db, LATER));
    expect(await world.book(booking(code.code, { paymentToken: MOCK_TOKEN_DECLINED }), { payments: slow })).toMatchObject({
      ok: false,
      code: "payment_failed",
    });
    expect(await onlyBooking()).toMatchObject({ status: "expired" });
    expect(await codeNow(code.id)).toMatchObject({ value: 3000, usedCount: 0 });
  });

  it("is not made, and its card not charged, when the card answers after the hold ran out", async () => {
    const code = await credit(3000);
    const slow = whileCharging(() => releaseExpiredHolds(world.db, LATER));
    const result = await world.book(booking(code.code), { payments: slow });
    expect(result).toMatchObject({ ok: false, status: 409, code: "slot_taken" });
    expect(!result.ok && result.message).toContain("Your booking was not made, and your card was not charged.");

    expect(await onlyBooking()).toMatchObject({ status: "expired" });
    expect(await codeNow(code.id)).toMatchObject({ value: 3000, usedCount: 0 });
    const [payment] = await world.db.select().from(payments);
    expect(payment).toMatchObject({ status: "failed", error: "Given back before it was taken: the booking was not made." });
    expect(world.releases).toEqual([payment.providerPaymentId]);
    expect(world.captures).toEqual([]);
    expect(await world.emails("booking_confirmation")).toEqual([]);
    // The time is free again.
    expect((await world.book(booking(code.code))).ok).toBe(true);
  });

  it("is given back by the scheduled task when the processor does not answer at once", async () => {
    const code = await credit(3000);
    const flaky: PaymentProvider = {
      ...whileCharging(() => releaseExpiredHolds(world.db, LATER)),
      release: async () => ({ ok: false, message: "No answer." }),
    };
    expect(await world.book(booking(code.code), { payments: flaky })).toMatchObject({ ok: false, code: "slot_taken" });
    expect((await world.db.select().from(payments))[0]).toMatchObject({ status: "authorized" });

    expect(await settleReservedPayments(world.db, { now: LATER, payments: world.provider, ownerEmail: null })).toEqual({ taken: 0, released: 1 });
    expect((await world.db.select().from(payments))[0]).toMatchObject({
      status: "failed",
      error: "Given back before it was taken: the booking was not made.",
    });
    expect(world.captures).toEqual([]);
  });
});
