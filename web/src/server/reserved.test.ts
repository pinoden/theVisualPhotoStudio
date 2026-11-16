import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookings, payments } from "@/db/schema";
import { cancelBooking, netCardPaidCents } from "./manage";
import { settleReservedPayments } from "./reserved";
import { createTestWorld, expectOk, FAR, hoursAfter, NOW, OWNER_EMAIL, type TestWorld } from "./testing";
import { formatInstant } from "./tz";

/**
 * A booking's card amount is reserved, the booking confirmed, and only then
 * is the money taken (the owner's go-ahead of 2026-11-16). What happens when
 * the second step does not go through at once.
 */
let world: TestWorld;
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(() => world.reset());

const onlyPayment = async () => (await world.db.select().from(payments))[0];
const settle = () => settleReservedPayments(world.db, world.manageDeps());

describe("money reserved for a booking and not taken yet", () => {
  it("leaves the booking standing, tells the owner once, and is taken by the scheduled task", async () => {
    world.failCaptures = "Square answered HTTP 503";
    // As the booking endpoint does, the owner's address comes with the booking.
    const booked = expectOk(await world.book({}, { ownerEmail: OWNER_EMAIL }));
    const [booking] = await world.db.select().from(bookings).where(eq(bookings.ref, booked.ref));
    expect(booking.status).toBe("confirmed");
    expect(await onlyPayment()).toMatchObject({ status: "authorized", error: "Square answered HTTP 503" });
    // Not money yet: nothing could be refunded, and no receipt counts it.
    expect(await netCardPaidCents(world.db, booking.id)).toBe(0);

    const [notice] = await world.emails("owner_capture_failed");
    expect(notice.toEmail).toBe(OWNER_EMAIL);
    expect(notice.subject).toBe(`Payment not taken yet for ${booked.ref}`);
    expect(notice.body).toContain(`The card for booking ${booked.ref} (Jane Smith) has $176 reserved on it, and the booking is confirmed`);
    expect(notice.body).toContain(`If the money has not been taken by ${formatInstant(hoursAfter(NOW, 24))}, Square gives the amount back`);

    // Still not going through: tried again, and the owner is not told twice.
    expect(await settle()).toEqual({ taken: 0, released: 0 });
    expect(await world.emails("owner_capture_failed")).toHaveLength(1);

    world.failCaptures = null;
    expect(await settle()).toEqual({ taken: 1, released: 0 });
    expect(await onlyPayment()).toMatchObject({ status: "succeeded", error: null });
    expect(await netCardPaidCents(world.db, booking.id)).toBe(17600);
    expect(await settle()).toEqual({ taken: 0, released: 0 });
  });

  it("is given back when the booking is cancelled before the money was taken", async () => {
    world.failCaptures = "Square answered HTTP 503";
    const booked = expectOk(await world.book({ date: FAR }));
    expectOk(await cancelBooking(world.db, booked.ref, { kind: "token", token: booked.manageToken }, world.manageDeps()));
    world.failCaptures = null;

    expect(await settle()).toEqual({ taken: 0, released: 1 });
    const payment = await onlyPayment();
    expect(payment).toMatchObject({ status: "failed", error: "Given back before it was taken: the booking was cancelled first." });
    expect(world.releases).toEqual([payment.providerPaymentId]);
    // Never taken, so nothing was refunded either.
    expect(world.refundCalls).toHaveLength(0);
    expect(await settle()).toEqual({ taken: 0, released: 0 });
  });

  it("is taken at once in the ordinary case, and the scheduled task finds nothing to do", async () => {
    const booked = expectOk(await world.book());
    const payment = await onlyPayment();
    expect(payment.status).toBe("succeeded");
    expect(world.captures).toEqual([payment.providerPaymentId]);
    expect(await world.emails("owner_capture_failed")).toHaveLength(0);
    expect(await settle()).toEqual({ taken: 0, released: 0 });
    expect(booked.ok).toBe(true);
  });
});
