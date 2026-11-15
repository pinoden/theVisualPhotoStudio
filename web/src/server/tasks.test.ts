import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookings, emailOutbox, promoCodes, settings } from "@/db/schema";
import { deliverPendingEmails, MAX_EMAIL_ATTEMPTS, queueEmail, resolveEmailTransport, type EmailTransport } from "./email";
import { cancelBooking } from "./manage";
import { resolvePayments } from "./payments";
import { completeVisits, runScheduledTasks } from "./tasks";
import { BASE_URL, createTestWorld, daysAfter, expectOk, h, hoursAfter, NOW, type TestWorld } from "./testing";

let world: TestWorld;
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(() => world.reset());

// world.book() books NEAR 10:00-12:00 local, which ends at 17:00 UTC.
const VISIT_END = new Date("2026-11-18T17:00:00Z");
const status = async (ref: string) => (await world.db.select().from(bookings).where(eq(bookings.ref, ref)))[0].status;

describe("after a visit", () => {
  it("marks it completed two hours after it ends and emails a loyalty code, once", async () => {
    const booked = expectOk(await world.book());

    expect(await completeVisits(world.db, hoursAfter(VISIT_END, 1.9), BASE_URL)).toEqual({ completed: 0, codes: 0 });
    expect(await status(booked.ref)).toBe("confirmed");

    const at = hoursAfter(VISIT_END, 2);
    expect(await completeVisits(world.db, at, BASE_URL)).toEqual({ completed: 1, codes: 1 });
    expect(await status(booked.ref)).toBe("completed");

    const [code] = await world.db.select().from(promoCodes);
    expect(code).toMatchObject({ kind: "percent", value: 10, source: "loyalty", email: "jane@example.com", maxUses: 1, usedCount: 0 });
    expect(code.code).toMatch(/^THANKS-/);
    expect(code.expiresAt).toEqual(daysAfter(at, 60));

    const [mail] = await world.emails("loyalty_code");
    expect(mail.toEmail).toBe("jane@example.com");
    expect(mail.subject).toBe("Thank you for visiting: 10% off your next booking");
    expect(mail.body).toContain(`Code: ${code.code}`);

    // Running again, or much later, sends nothing more.
    expect(await completeVisits(world.db, hoursAfter(at, 1), BASE_URL)).toEqual({ completed: 0, codes: 0 });
    expect(await completeVisits(world.db, daysAfter(at, 3), BASE_URL)).toEqual({ completed: 0, codes: 0 });
    expect(await world.emails("loyalty_code")).toHaveLength(1);
  });

  it("gives the customer that discount on their next booking, and nobody else", async () => {
    expectOk(await world.book());
    await completeVisits(world.db, hoursAfter(VISIT_END, 2), BASE_URL);
    const [{ code }] = await world.db.select().from(promoCodes);
    const later = { now: daysAfter(NOW, 10) };

    const stranger = await world.book(
      { date: "2026-12-02", promoCode: code, customer: { name: "Eve", email: "eve@example.com", phone: "5550100100" } },
      later,
    );
    expect(stranger).toMatchObject({ ok: false, code: "invalid_code" });

    const next = expectOk(await world.book({ date: "2026-12-02", promoCode: code }, later));
    expect(next.totalCents).toBe(15840);
  });

  it("sends nothing for a no-show or a cancelled booking", async () => {
    const noShow = expectOk(await world.book());
    await world.db.update(bookings).set({ status: "no_show" }).where(eq(bookings.ref, noShow.ref));
    const cancelled = expectOk(await world.book({ startMinute: h(14) }));
    await cancelBooking(world.db, cancelled.ref, { kind: "token", token: cancelled.manageToken }, world.manageDeps());

    expect(await completeVisits(world.db, daysAfter(VISIT_END, 1), BASE_URL)).toEqual({ completed: 0, codes: 0 });
    expect(await world.db.select().from(promoCodes)).toHaveLength(0);
    expect(await status(noShow.ref)).toBe("no_show");
  });

  it("also rewards a visit that staff marked completed by hand", async () => {
    const booked = expectOk(await world.book());
    await world.db.update(bookings).set({ status: "completed" }).where(eq(bookings.ref, booked.ref));
    expect(await completeVisits(world.db, hoursAfter(VISIT_END, 1), BASE_URL)).toEqual({ completed: 0, codes: 0 }); // too soon
    expect(await completeVisits(world.db, hoursAfter(VISIT_END, 3), BASE_URL)).toEqual({ completed: 0, codes: 1 });
  });

  it("follows the owner's loyalty settings", async () => {
    await world.db.insert(settings).values([
      { key: "loyaltyPercent", value: 15 },
      { key: "loyaltyValidDays", value: 30 },
      { key: "loyaltyDelayHours", value: 0 },
    ]);
    expectOk(await world.book());
    expect(await completeVisits(world.db, VISIT_END, BASE_URL)).toEqual({ completed: 1, codes: 1 });
    expect((await world.db.select().from(promoCodes))[0]).toMatchObject({ value: 15, expiresAt: daysAfter(VISIT_END, 30) });
    expect((await world.emails("loyalty_code"))[0].subject).toContain("15% off");
  });

  it("completes visits but sends no codes while loyalty is switched off, and only rewards recent visits once it is on", async () => {
    await world.db.insert(settings).values({ key: "loyaltyEnabled", value: false });
    const booked = expectOk(await world.book());
    expect(await completeVisits(world.db, hoursAfter(VISIT_END, 2), BASE_URL)).toEqual({ completed: 1, codes: 0 });
    expect(await status(booked.ref)).toBe("completed");
    expect(await world.db.select().from(promoCodes)).toHaveLength(0);

    await world.db.update(settings).set({ value: true }).where(eq(settings.key, "loyaltyEnabled"));
    expect(await completeVisits(world.db, daysAfter(VISIT_END, 8), BASE_URL)).toEqual({ completed: 0, codes: 0 }); // too long ago
    expect(await completeVisits(world.db, daysAfter(VISIT_END, 6), BASE_URL)).toEqual({ completed: 0, codes: 1 });
  });
});

describe("email delivery", () => {
  const sent: { to: string; subject: string }[] = [];
  let failWith: string | null = null;
  const transport: EmailTransport = {
    name: "test",
    async send(message) {
      if (failWith) return { ok: false, error: failWith };
      sent.push({ to: message.to, subject: message.subject });
      return { ok: true };
    },
  };
  beforeEach(() => {
    sent.length = 0;
    failWith = null;
  });

  const message = (n: number) => ({ to: `person${n}@example.com`, subject: `Subject ${n}`, body: "Body", kind: "test" });

  it("sends each queued message once", async () => {
    await queueEmail(world.db, message(1));
    await queueEmail(world.db, message(2));
    expect(await deliverPendingEmails(world.db, transport, NOW)).toEqual({ sent: 2, failed: 0 });
    expect(sent.map((m) => m.to).sort()).toEqual(["person1@example.com", "person2@example.com"]);
    expect(await deliverPendingEmails(world.db, transport, NOW)).toEqual({ sent: 0, failed: 0 });
    expect((await world.db.select().from(emailOutbox)).every((row) => row.sentAt !== null)).toBe(true);
  });

  it("does not send a message twice when two deliveries run at once", async () => {
    await queueEmail(world.db, message(1));
    await Promise.all([deliverPendingEmails(world.db, transport, NOW), deliverPendingEmails(world.db, transport, NOW)]);
    expect(sent).toHaveLength(1);
  });

  it("keeps a message that failed, retries it, and gives up after five attempts", async () => {
    await queueEmail(world.db, message(1));
    failWith = "mailbox unavailable";
    for (let attempt = 1; attempt <= MAX_EMAIL_ATTEMPTS; attempt++) {
      expect(await deliverPendingEmails(world.db, transport, NOW)).toEqual({ sent: 0, failed: 1 });
    }
    expect((await world.db.select().from(emailOutbox))[0]).toMatchObject({ attempts: 5, sentAt: null, error: "mailbox unavailable" });
    failWith = null;
    expect(await deliverPendingEmails(world.db, transport, NOW)).toEqual({ sent: 0, failed: 0 }); // given up
    expect(sent).toHaveLength(0);
  });

  it("recovers when delivery starts working before the limit", async () => {
    await queueEmail(world.db, message(1));
    failWith = "timeout";
    await deliverPendingEmails(world.db, transport, NOW);
    failWith = null;
    expect(await deliverPendingEmails(world.db, transport, NOW)).toEqual({ sent: 1, failed: 0 });
    expect((await world.db.select().from(emailOutbox))[0]).toMatchObject({ attempts: 2, error: null });
  });

  it("leaves mail queued when no delivery service is configured", async () => {
    await queueEmail(world.db, message(1));
    expect(await deliverPendingEmails(world.db, null, NOW)).toEqual({ sent: 0, failed: 0 });
    expect((await world.db.select().from(emailOutbox))[0]).toMatchObject({ attempts: 0, sentAt: null });
  });

  it("picks the delivery service from configuration", () => {
    expect(resolveEmailTransport({ RESEND_API_KEY: "k", EMAIL_FROM: "Studio <hi@studio.test>", NODE_ENV: "production" })?.name).toBe("resend");
    expect(resolveEmailTransport({ NODE_ENV: "development" })?.name).toBe("log");
    expect(resolveEmailTransport({ NODE_ENV: "production" })).toBeNull();
    expect(resolveEmailTransport({ RESEND_API_KEY: "k", NODE_ENV: "production" })).toBeNull(); // sender address missing
  });
});

describe("the scheduled run", () => {
  it("does every recurring job and reports what it did", async () => {
    const delivered: string[] = [];
    const email: EmailTransport = {
      name: "test",
      async send(message) {
        delivered.push(message.subject);
        return { ok: true };
      },
    };
    const booked = expectOk(await world.book());
    const summary = await runScheduledTasks(world.db, { ...world.manageDeps({ now: hoursAfter(VISIT_END, 2) }), email });
    expect(summary).toEqual({
      holdsReleased: 0,
      visitsCompleted: 1,
      loyaltyCodes: 1,
      refundsSucceeded: 0,
      refundsFailed: 0,
      emailsSent: 2, // the booking confirmation and the loyalty code
      emailsFailed: 0,
    });
    expect(delivered).toContain(`Booking confirmed: ${booked.ref}`);
    expect(delivered).toContain("Thank you for visiting: 10% off your next booking");
  });
});

describe("which card processor is used", () => {
  const square = { SQUARE_ACCESS_TOKEN: "t", SQUARE_LOCATION_ID: "l", SQUARE_APPLICATION_ID: "a" };

  it("uses Square only when all three credentials are present", () => {
    expect(resolvePayments({ ...square, NODE_ENV: "production" }).client).toEqual({
      mode: "square",
      squareApplicationId: "a",
      squareLocationId: "l",
      squareEnvironment: "sandbox",
    });
    expect(resolvePayments({ ...square, SQUARE_ENVIRONMENT: "production", NODE_ENV: "production" }).client.squareEnvironment).toBe("production");
    expect(resolvePayments({ SQUARE_ACCESS_TOKEN: "t", NODE_ENV: "production" }).client.mode).toBe("disabled");
  });

  it("never falls back to the pretend processor in production unless asked to", () => {
    expect(resolvePayments({ NODE_ENV: "production" })).toEqual({ provider: null, client: { mode: "disabled" } });
    expect(resolvePayments({ NODE_ENV: "production", PAYMENTS_MODE: "mock" }).client.mode).toBe("mock");
    expect(resolvePayments({ NODE_ENV: "development" }).client.mode).toBe("mock");
  });

  it("never sends the secret access token to the browser", () => {
    expect(JSON.stringify(resolvePayments({ ...square, SQUARE_ACCESS_TOKEN: "very-secret", NODE_ENV: "production" }).client)).not.toContain("very-secret");
  });
});
