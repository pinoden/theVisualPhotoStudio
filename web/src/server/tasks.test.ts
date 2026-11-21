import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { bookings, emailOutbox, payments, promoCodes, settings } from "@/db/schema";
import { deliverPendingEmails, MAX_EMAIL_ATTEMPTS, queueEmail, replaceQueuedEmail, resolveEmailTransport, type EmailTransport } from "./email";
import { cancelBooking } from "./manage";
import { MOCK_TOKEN_DECLINED, mockProvider, resolvePayments, type PaymentProvider } from "./payments";
import { createAdminBooking, moveBooking } from "./appointments";
import { saveAccessInstructions } from "./settings";
import { completeVisits, queueReminders, runScheduledTasks } from "./tasks";
import {
  BASE_URL,
  createTestWorld,
  daysAfter,
  expectOk,
  h,
  hoursAfter,
  minutesAfter,
  NOW,
  type TestWorld,
} from "./testing";

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
  it("marks it completed two hours after it ends", async () => {
    const booked = expectOk(await world.book());

    expect(await completeVisits(world.db, hoursAfter(VISIT_END, 1.9), BASE_URL)).toEqual({ completed: 0, codes: 0 });
    expect(await status(booked.ref)).toBe("confirmed");

    // One visit earns nothing yet. What five of them earn is in loyalty.test.ts.
    expect(await completeVisits(world.db, hoursAfter(VISIT_END, 2), BASE_URL)).toEqual({ completed: 1, codes: 0 });
    expect(await status(booked.ref)).toBe("completed");
    expect(await world.db.select().from(promoCodes)).toHaveLength(0);

    // Running again, or much later, changes nothing.
    expect(await completeVisits(world.db, daysAfter(VISIT_END, 3), BASE_URL)).toEqual({ completed: 0, codes: 0 });
  });

  it("leaves a no-show and a cancelled booking as they are", async () => {
    const noShow = expectOk(await world.book());
    await world.db.update(bookings).set({ status: "no_show" }).where(eq(bookings.ref, noShow.ref));
    const cancelled = expectOk(await world.book({ startMinute: h(14) }));
    await cancelBooking(world.db, cancelled.ref, { kind: "token", token: cancelled.manageToken }, world.manageDeps());

    expect(await completeVisits(world.db, daysAfter(VISIT_END, 1), BASE_URL)).toEqual({ completed: 0, codes: 0 });
    expect(await status(noShow.ref)).toBe("no_show");
    expect(await status(cancelled.ref)).toBe("cancelled");
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

  it("sends a message as it is when it is taken, put right meanwhile or not", async () => {
    await queueEmail(world.db, message(1));
    const second = await queueEmail(world.db, message(2));
    const bodies: string[] = [];
    // While the first goes out, the second, already read with the others, is put right.
    const putRight: EmailTransport = {
      name: "test",
      async send(mail) {
        bodies.push(mail.text);
        if (bodies.length === 1) expect(await replaceQueuedEmail(world.db, second, { ...message(2), body: "Put right" })).toBe(true);
        return { ok: true };
      },
    };
    expect(await deliverPendingEmails(world.db, putRight, NOW)).toEqual({ sent: 2, failed: 0 });
    expect(bodies).toEqual(["Body", "Put right"]);
    // Once it has left, it is not replaced.
    expect(await replaceQueuedEmail(world.db, second, { ...message(2), body: "Too late" })).toBe(false);
  });

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
    // The browser tests' own server for a production build reads its emails from the outbox, as development does.
    const testServer = { NODE_ENV: "production", BROWSER_TEST_SERVER: "1", ALLOW_PGLITE_IN_PRODUCTION: "1", PAYMENTS_MODE: "mock" };
    expect(resolveEmailTransport(testServer)?.name).toBe("log");
    expect(resolveEmailTransport({ ...testServer, DATABASE_URL: "postgres://db.example/site" })).toBeNull();
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
    // One visit earns the free hour here, so that the run has one to send.
    await world.db.insert(settings).values({ key: "loyaltyVisits", value: 1 });
    const booked = expectOk(await world.book());
    const summary = await runScheduledTasks(world.db, { ...world.manageDeps({ now: hoursAfter(VISIT_END, 2) }), email });
    expect(summary).toEqual({
      holdsReleased: 0,
      paymentsFlagged: 0,
      reservationsTaken: 0,
      reservationsReleased: 0,
      visitsCompleted: 1,
      loyaltyCodes: 1,
      reviewRequestsQueued: 0,
      remindersQueued: 0,
      refundsSucceeded: 0,
      refundsFailed: 0,
      refundsSettled: 0,
      refundsRejected: 0,
      payLinksPaid: 0,
      payLinksClosed: 0,
      waitingEndsFinished: 0,
      membershipMonthsPaid: 0,
      membershipProblems: 0,
      membershipsCarriedOn: 0,
      emailsSent: 2, // the booking confirmation and the free hour
      emailsFailed: 0,
      pagesRemoved: 0,
    });
    expect(delivered).toContain(`Booking confirmed: ${booked.ref}`);
    expect(delivered).toContain("You have earned a free hour in the studio");
  });

  it("queues a single Google review request 24 hours after a completed appointment", async () => {
    const completed = expectOk(await world.book());
    const noShow = expectOk(await world.book({ startMinute: h(14) }));
    await world.db.update(bookings).set({ status: "no_show" }).where(eq(bookings.ref, noShow.ref));
    const run = (now: Date) => runScheduledTasks(world.db, { ...world.manageDeps({ now }), email: null });
    const due = hoursAfter(VISIT_END, 24);

    expect((await run(minutesAfter(due, -1))).reviewRequestsQueued).toBe(0);
    expect((await run(due)).reviewRequestsQueued).toBe(1);
    expect((await run(daysAfter(due, 1))).reviewRequestsQueued).toBe(0);
    const requests = await world.emails("review_request");
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toContain("https://g.page/r/CTQ9ea1fatgnEBM/review");
    expect(requests[0].body).toContain(completed.ref);
  });
});

describe("the reminder before a visit", () => {
  // world.book() books NEAR 10:00-12:00 local: it starts at 15:00 UTC, and was made at NOW, four days before.
  const START = new Date("2026-11-18T15:00:00Z");
  const reminders = () => world.emails("booking_reminder");

  it("is sent once, 24 hours before the start, with the visit and how to get in as it is now", async () => {
    const booked = expectOk(await world.book());
    await saveAccessInstructions(world.db, "Door code 4321, second floor.");
    expect(await queueReminders(world.db, minutesAfter(hoursAfter(START, -24), -1))).toBe(0);
    expect(await queueReminders(world.db, hoursAfter(START, -24))).toBe(1);
    expect(await queueReminders(world.db, hoursAfter(START, -20))).toBe(0);
    const [mail] = await reminders();
    expect(mail.toEmail).toBe("jane@example.com");
    expect(mail.subject).toBe("Reminder: your booking at The Visuals Photo Studio, Wed, Nov 18, 2026, 10:00 AM");
    expect(mail.body).toContain(`Reference: ${booked.ref}`);
    expect(mail.body).toContain("Studio: Studio Blanche");
    expect(mail.body).toContain("When: Wed, Nov 18, 2026, 10:00 AM (2 hours)");
    expect(mail.body).toContain("Getting in:\nDoor code 4321, second floor.");
    // Paid by card when it was made: nothing more to pay is said.
    expect(mail.body).not.toContain("to pay");
  });

  it("still goes when the scheduled task runs late, but never once the visit has started", async () => {
    expectOk(await world.book());
    expectOk(await world.book({ startMinute: h(14) }));
    // The task did not run for a day: at 9:30 the first visit is half an hour away, the second four and a half hours.
    expect(await queueReminders(world.db, hoursAfter(START, -0.5))).toBe(2);
    const late = expectOk(await world.book({ date: "2026-11-19" }));
    expect(await queueReminders(world.db, new Date("2026-11-19T15:01:00Z"))).toBe(0);
    expect((await reminders()).some((mail) => mail.body.includes(late.ref))).toBe(false);
  });

  it("is not sent for a booking made inside the reminder's hours, cancelled, or waiting to be moved, nor when switched off", async () => {
    // Made ten hours before it starts (the owners let bookings be made 2 hours ahead): the confirmation has just gone.
    await world.db.insert(settings).values({ key: "minLeadHours", value: 2 });
    expectOk(await world.book({}, { now: hoursAfter(START, -10) }));
    const cancelled = expectOk(await world.book({ startMinute: h(14) }));
    await world.db.update(bookings).set({ status: "cancelled", cancelReason: "customer" }).where(eq(bookings.ref, cancelled.ref));
    const waiting = expectOk(await world.book({ studioIds: [world.ids.paris] }));
    await world.db.update(bookings).set({ label: "reschedule_pending" }).where(eq(bookings.ref, waiting.ref));
    expect(await queueReminders(world.db, hoursAfter(START, -5))).toBe(0);
    // Switched off by the owners: a booking that would get one gets none.
    expectOk(await world.book({ studioIds: [world.ids.dayglow] }));
    await world.db.insert(settings).values({ key: "reminderHours", value: 0 });
    expect(await queueReminders(world.db, hoursAfter(START, -5))).toBe(0);
    await world.db.update(settings).set({ value: 48 }).where(eq(settings.key, "reminderHours"));
    expect(await queueReminders(world.db, hoursAfter(START, -47))).toBe(1);
  });

  it("says what is still to pay at the studio for a booking the studio made", async () => {
    const owner = await world.addUser("owner@studio.test", "owner", "Olivia");
    const made = expectOk(
      await createAdminBooking(
        world.db,
        owner,
        { studioIds: [world.ids.blanche], date: "2026-11-18", startMinute: h(10), durationMinutes: 120, customer: { name: "Dana Diaz", email: "dana@example.com", phone: "407-555-0133" } },
        { now: NOW, baseUrl: BASE_URL },
      ),
    );
    expect(await queueReminders(world.db, hoursAfter(START, -24))).toBe(1);
    const [mail] = await reminders();
    expect(mail.body).toContain(made.ref);
    expect(mail.body).toContain("To pay at the studio: $176");
  });

  it("comes again before the new time when the studio moves the booking, unless the new time is closer than its hours", async () => {
    const owner = await world.addUser("owner@studio.test", "owner", "Olivia");
    const booked = expectOk(await world.book());
    expect(await queueReminders(world.db, hoursAfter(START, -24))).toBe(1);
    // Moved three days later: a reminder again, 24 hours before the new start (Saturday 21st, 10:00 local).
    expectOk(await moveBooking(world.db, owner, booked.ref, { date: "2026-11-21", startMinute: h(10), countsAsClientMove: false }, hoursAfter(START, -23)));
    const newStart = new Date("2026-11-21T15:00:00Z");
    expect(await queueReminders(world.db, hoursAfter(newStart, -25))).toBe(0);
    expect(await queueReminders(world.db, hoursAfter(newStart, -24))).toBe(1);
    // Moved again an hour before it starts, to that afternoon: the email about the move tells the time, and no reminder follows.
    expectOk(await moveBooking(world.db, owner, booked.ref, { date: "2026-11-21", startMinute: h(15), countsAsClientMove: false }, hoursAfter(newStart, -1)));
    expect(await queueReminders(world.db, hoursAfter(newStart, 1))).toBe(0);
    expect(await reminders()).toHaveLength(2);
  });
});

describe("a charge that was interrupted", () => {
  // The server stopping mid-charge looks, from the inside, like the charge never returning.
  const crashing: PaymentProvider = {
    ...mockProvider,
    name: "mock",
    charge: async () => {
      throw new Error("the server stopped");
    },
    refund: mockProvider.refund,
  };
  const email: EmailTransport = { name: "test", send: async () => ({ ok: true }) };
  const runAt = (minutes: number) =>
    runScheduledTasks(world.db, { ...world.manageDeps({ now: minutesAfter(NOW, minutes) }), email });

  it("is closed once its hold has expired, and nobody has to check it: the card was at most reserved", async () => {
    await expect(world.book({}, { payments: crashing })).rejects.toThrow("the server stopped");
    expect((await world.db.select().from(payments))[0].status).toBe("pending");

    // While the hold lasts, the charge may still be on its way.
    expect(await runAt(5)).toMatchObject({ holdsReleased: 0, paymentsFlagged: 0 });

    expect(await runAt(11)).toMatchObject({ holdsReleased: 1, paymentsFlagged: 1 });
    expect((await world.db.select().from(payments))[0]).toMatchObject({
      status: "failed",
      error: "Interrupted before its result was recorded. Nothing was taken: a reserved amount is given back by Square by itself.",
    });
    expect(await world.emails()).toHaveLength(0);
    expect((await runAt(12)).paymentsFlagged).toBe(0);
  });

  it("is not confused with a card that was simply refused", async () => {
    expect((await world.book({ paymentToken: MOCK_TOKEN_DECLINED })).ok).toBe(false);
    expect((await runAt(11)).paymentsFlagged).toBe(0);
  });
});

describe("which card processor is used", () => {
  // Square's application ids say which of its accounts they are for: a sandbox one begins with "sandbox-".
  const square = { SQUARE_ACCESS_TOKEN: "t", SQUARE_LOCATION_ID: "l", SQUARE_APPLICATION_ID: "sandbox-sq0idb-a" };
  const live = { ...square, SQUARE_APPLICATION_ID: "sq0idp-a" };

  it("uses Square only when all three credentials are present", () => {
    expect(resolvePayments({ ...square, NODE_ENV: "production" }).client).toEqual({
      mode: "square",
      squareApplicationId: "sandbox-sq0idb-a",
      squareLocationId: "l",
      squareEnvironment: "sandbox",
    });
    expect(resolvePayments({ ...live, SQUARE_ENVIRONMENT: "production", NODE_ENV: "production" }).client.squareEnvironment).toBe("production");
    expect(resolvePayments({ SQUARE_ACCESS_TOKEN: "t", NODE_ENV: "production" }).client.mode).toBe("disabled");
  });

  it("tells Square's sandbox from its live account by the application id, and turns payments off when the setting disagrees", () => {
    expect(resolvePayments({ ...square, NODE_ENV: "production" }).provider?.name).toBe("square-sandbox");
    expect(resolvePayments({ ...live, NODE_ENV: "production" }).provider?.name).toBe("square");
    expect(resolvePayments({ ...live, SQUARE_ENVIRONMENT: " Production ", NODE_ENV: "production" }).provider?.name).toBe("square");
    // A setting that says the other account, or neither: no processor at all, rather than the wrong one.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolvePayments({ ...live, SQUARE_ENVIRONMENT: "sandbox", NODE_ENV: "production" })).toEqual({
      provider: null,
      client: {
        mode: "disabled",
        problem: "Card payments are off: SQUARE_ENVIRONMENT says sandbox, but the application id is of Square's live account. Set SQUARE_ENVIRONMENT to production, or leave it empty.",
      },
    });
    expect(resolvePayments({ ...square, SQUARE_ENVIRONMENT: "production", NODE_ENV: "production" }).client.mode).toBe("disabled");
    expect(resolvePayments({ ...live, SQUARE_ENVIRONMENT: "prod", NODE_ENV: "production" }).client.mode).toBe("disabled");
    expect(errors).toHaveBeenCalledWith(
      "Card payments are off: SQUARE_ENVIRONMENT says sandbox, but the application id is of Square's live account. Set SQUARE_ENVIRONMENT to production, or leave it empty.",
    );
    errors.mockRestore();
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
