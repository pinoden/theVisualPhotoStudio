import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookings, payments, refunds } from "@/db/schema";
import { listRefundProblems } from "./admin";
import { getAppointment } from "./appointments";
import type { AuthUser } from "./auth";
import { netCardPaidCents, ownerCancelBooking, ownerRefund, recordRefundMadeInSquare, retryOpenRefunds } from "./manage";
import { loadReceipts } from "./receipts";
import { createTestWorld, expectOk, FAR, NOW, type TestWorld } from "./testing";

/**
 * A refund the site could not make, which the owner then made by hand in
 * Square: the overview's "Refunded it in Square" records it, so the site
 * stops trying and counts it as made.
 */
let world: TestWorld;
let owner: AuthUser;
let sam: AuthUser; // staff
let mia: AuthUser; // a manager

beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser("owner@studio.test", "owner", "Olivia");
  sam = await world.addUser("sam@studio.test", "staff", "Sam");
  mia = await world.addUser("mia@studio.test", "manager", "Mia");
});

/** A $176 booking, and a $50 refund of it that Square refuses. */
async function failedRefund() {
  const booked = expectOk(await world.book({ date: FAR }));
  world.failRefunds = "The card account is closed";
  expectOk(await ownerRefund(world.db, booked.ref, { amountCents: 5000, reason: "Lights failed for a while" }, world.manageDeps()));
  world.failRefunds = null;
  const [problem] = await listRefundProblems(world.db);
  const [row] = await world.db.select().from(bookings).where(eq(bookings.ref, booked.ref));
  return { ref: booked.ref, bookingId: row.id, problem };
}

describe("a refund made by hand in Square", () => {
  it("is recorded by an owner: the site stops trying, counts it as made, and the client's receipt shows it", async () => {
    const { ref, bookingId, problem } = await failedRefund();
    expect(problem).toMatchObject({ ref, amountCents: 5000, status: "failed", error: "The card account is closed" });
    // The booking's history says what was sent and that it did not go through, so what follows reads in order.
    const history = (await getAppointment(world.db, owner, ref, NOW))!.history.map((line) => [line.actor, line.note]);
    expect(history.slice(-2)).toEqual([
      ["the studio", "Refund $50 to the card: Lights failed for a while"],
      ["system", "The refund of $50 did not go through, and is tried again. The processor's answer: The card account is closed."],
    ]);
    // Owed already: it counts against what the card holds, so it cannot be refunded a second time.
    expect(await netCardPaidCents(world.db, bookingId)).toBe(12600);

    expectOk(await recordRefundMadeInSquare(world.db, owner, problem.refundId, NOW));
    expect(await listRefundProblems(world.db)).toEqual([]);
    const [refund] = await world.db.select().from(refunds);
    expect(refund).toMatchObject({ status: "succeeded", settledAt: NOW, error: null });
    expect((await world.db.select().from(payments))[0].refundedCents).toBe(5000);
    expect(await netCardPaidCents(world.db, bookingId)).toBe(12600);

    // The scheduled task does not send it again.
    const calls = world.refundCalls.length;
    expect(await retryOpenRefunds(world.db, world.manageDeps())).toEqual({ succeeded: 0, failed: 0 });
    expect(world.refundCalls).toHaveLength(calls);

    const [receipt] = (await loadReceipts(world.db, "jane@example.com")).receipts;
    expect(receipt).toMatchObject({ refundedCents: 5000, netCents: 12600, status: "partly_refunded" });
    // Made, on the day it was recorded as made in Square.
    expect(receipt.payments[0].refunds).toMatchObject([{ amountCents: 5000, state: "made", at: NOW.toISOString() }]);
    expect((await getAppointment(world.db, owner, ref, NOW))!.history.at(-1)).toMatchObject({
      actor: "owner@studio.test",
      note: "A refund of $50 that the site could not make was made by hand in Square",
    });
    // Done once: a second time is refused.
    expect(await recordRefundMadeInSquare(world.db, owner, problem.refundId, NOW)).toMatchObject({ ok: false, message: "That refund is made already." });
  });

  it("counts while it is owed: no more can be refunded than what is left, and both made add up to what was paid", async () => {
    const { ref, bookingId, problem } = await failedRefund();
    expect(await ownerCancelBooking(world.db, ref, { refundCents: 17600 }, world.manageDeps())).toMatchObject({
      ok: false,
      message: "At most $126 can be refunded to the card for this booking.",
    });
    expectOk(await ownerCancelBooking(world.db, ref, { refundCents: 12600 }, world.manageDeps()));
    expectOk(await recordRefundMadeInSquare(world.db, owner, problem.refundId, NOW));
    expect((await world.db.select().from(payments))[0].refundedCents).toBe(17600);
    expect(await netCardPaidCents(world.db, bookingId)).toBe(0);
    const [receipt] = (await loadReceipts(world.db, "jane@example.com")).receipts;
    expect(receipt).toMatchObject({ paidCents: 17600, refundedCents: 17600, netCents: 0, status: "refunded" });
  });

  it("stays made when a retry by the scheduled task fails at the same moment", async () => {
    const { problem } = await failedRefund();
    const deps = world.manageDeps();
    const provider = deps.payments!;
    // The processor answers the retry with a failure, after the owner has recorded the refund as made.
    const racing = {
      ...deps,
      payments: {
        ...provider,
        refund: async () => {
          expectOk(await recordRefundMadeInSquare(world.db, owner, problem.refundId, NOW));
          return { ok: false as const, message: "The card account is closed" };
        },
      },
    };
    await retryOpenRefunds(world.db, racing);
    expect((await world.db.select().from(refunds))[0]).toMatchObject({ status: "succeeded" });
    expect((await world.db.select().from(payments))[0].refundedCents).toBe(5000);
    expect(await listRefundProblems(world.db)).toEqual([]);
  });

  it("is not for a refund still waiting to be sent, which the site may yet make", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    // No processor at the moment: recorded, and waiting to be sent.
    expectOk(await ownerRefund(world.db, booked.ref, { amountCents: 5000, reason: "" }, { ...world.manageDeps(), payments: null }));
    const [waiting] = await listRefundProblems(world.db);
    expect(waiting.status).toBe("pending");
    expect(await recordRefundMadeInSquare(world.db, owner, waiting.refundId, NOW)).toMatchObject({ ok: false, reason: "not_failed" });
    expect((await world.db.select().from(refunds))[0].status).toBe("pending");
  });

  it("is the owners' to record", async () => {
    const { problem } = await failedRefund();
    for (const viewer of [sam, mia]) {
      expect(await recordRefundMadeInSquare(world.db, viewer, problem.refundId, NOW)).toMatchObject({ ok: false, reason: "forbidden" });
    }
    expect(await recordRefundMadeInSquare(world.db, owner, "not-an-id", NOW)).toMatchObject({ ok: false, reason: "not_found" });
    expect(await recordRefundMadeInSquare(world.db, owner, "00000000-0000-4000-8000-000000000000", NOW)).toMatchObject({ ok: false, reason: "not_found" });
    expect((await world.db.select().from(refunds))[0].status).toBe("failed");
  });
});
