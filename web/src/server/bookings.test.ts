import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createMemoryDb, pgErrorCode, type Db } from "@/db/client";
import { seed } from "@/db/seed";
import {
  bookings,
  emailOutbox,
  payments,
  priceRules,
  settings,
  specialDates,
  studioHolds,
  studioHours,
  studios,
} from "@/db/schema";
import { createBooking, getBookingByToken, hashToken, quoteSelection, type BookingInput } from "./bookings";
import { loadDayAvailability } from "./availability";
import { loadCatalog } from "./catalog";
import { MOCK_TOKEN_DECLINED, MOCK_TOKEN_OK, mockProvider, type PaymentProvider } from "./payments";
import { combinedStarts, freeStarts } from "@/lib/domain/availability";

// Saturday 2026-11-14, 10:00 in Winter Park (EST, UTC-5).
const NOW = new Date("2026-11-14T15:00:00Z");
const WED = "2026-11-18";
const SAT = "2026-11-21";
const h = (hours: number) => hours * 60;

let db: Db;
let close: () => Promise<void>;
let ids: Record<string, string>;
let charges: { amountCents: number; idempotencyKey: string }[];

const countingProvider: PaymentProvider = {
  ...mockProvider,
  name: "mock",
  async charge(request) {
    const result = await mockProvider.charge(request);
    if (result.ok) charges.push({ amountCents: request.amountCents, idempotencyKey: request.idempotencyKey });
    return result;
  },
  refund: mockProvider.refund,
};

function input(overrides: Partial<BookingInput> = {}): BookingInput {
  return {
    studioIds: [ids.blanche],
    date: WED,
    startMinute: h(10),
    durationMinutes: 120,
    customer: { name: "Test Person", email: "Test@Example.com", phone: "555-010-0100" },
    acceptTerms: true,
    paymentToken: MOCK_TOKEN_OK,
    ...overrides,
  };
}

function book(overrides: Partial<BookingInput> = {}, deps: Partial<Parameters<typeof createBooking>[2]> = {}) {
  return createBooking(db, input(overrides), {
    now: NOW,
    payments: countingProvider,
    baseUrl: "https://studio.test",
    ...deps,
  });
}

async function resetData() {
  await db.execute(sql`truncate email_outbox, refunds, payments, booking_addons, studio_holds, blocks, bookings, special_dates, settings cascade`);
  charges = [];
}

beforeAll(async () => {
  ({ db, close } = await createMemoryDb());
  await seed(db);
  const rows = await db.select({ id: studios.id, slug: studios.slug }).from(studios);
  ids = Object.fromEntries(rows.map((r) => [r.slug, r.id]));
});

afterAll(async () => {
  await close();
});

beforeEach(resetData);

describe("creating a booking", () => {
  it("books one studio, charges the tier price and queues a confirmation email", async () => {
    const result = await book();
    expect(result).toMatchObject({ ok: true, totalCents: 17600 });
    if (!result.ok) return;
    expect(result.ref).toMatch(/^VS-[0-9A-Z]{6}$/);

    const [row] = await db.select().from(bookings).where(eq(bookings.ref, result.ref));
    expect(row.status).toBe("confirmed");
    expect(row.customerEmail).toBe("test@example.com");
    // 10:00 Eastern Standard Time is 15:00 UTC.
    expect(row.startAt.toISOString()).toBe("2026-11-18T15:00:00.000Z");
    expect(row.endAt.toISOString()).toBe("2026-11-18T17:00:00.000Z");
    expect(row.manageTokenHash).toBe(hashToken(result.manageToken));

    const paid = await db.select().from(payments);
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({ status: "succeeded", amountCents: 17600, provider: "mock" });
    expect(charges).toEqual([{ amountCents: 17600, idempotencyKey: row.id }]);

    const [mail] = await db.select().from(emailOutbox);
    expect(mail.toEmail).toBe("test@example.com");
    expect(mail.body).toContain(result.ref);
    expect(mail.body).toContain(`https://studio.test/booking/${result.ref}?t=${result.manageToken}`);
    expect(mail.body).toContain("Wed, Nov 18, 2026, 10:00 AM");
  });

  it("quotes and books only the studio bundles that include Paris", async () => {
    const selection = { studioIds: [ids.dayglow, ids.blanche], durationMinutes: 60, date: WED };
    const refusal = { ok: false, status: 422, code: "invalid_price", message: "To book Blanche and Dayglow together, add Paris or choose a different combination." };
    expect(await quoteSelection(db, selection, NOW)).toEqual(refusal);
    expect(await book(selection)).toEqual(refusal);
    expect(charges).toHaveLength(0);
    expect(await db.select().from(studioHolds)).toHaveLength(0);

    const result = await book({ studioIds: [ids.blanche, ids.paris], durationMinutes: 60 });
    expect(result).toMatchObject({ ok: true, totalCents: 12480 }); // ($88 + $68) less 20%
    const holds = await db.select().from(studioHolds);
    expect(holds.map((x) => x.studioId).sort()).toEqual([ids.blanche, ids.paris].sort());
    expect(holds.every((x) => x.active)).toBe(true);

    const dayglowAndParis = await book({ studioIds: [ids.dayglow, ids.paris], durationMinutes: 60, startMinute: h(12) });
    expect(dayglowAndParis).toMatchObject({ ok: true, totalCents: 11680 }); // ($78 + $68) less 20%
    const all = await book({ studioIds: [ids.blanche, ids.dayglow, ids.paris], durationMinutes: 60, startMinute: h(14) });
    expect(all).toMatchObject({ ok: true, totalCents: 23400 - Math.round(23400 * 0.22) });
  });

  it("uses the owner's discount setting", async () => {
    await db.insert(settings).values({ key: "multiStudioPercent", value: { 2: 10 } });
    const result = await book({ studioIds: [ids.blanche, ids.paris], durationMinutes: 60 });
    expect(result).toMatchObject({ ok: true, totalCents: 15600 - 1560 });
  });

  it("charges add-ons and refuses ones that do not fit the booking", async () => {
    const catalog = await loadCatalog(db);
    const pet = catalog.addons.find((a) => a.slug === "pet-fee")!;
    const people = catalog.addons.find((a) => a.slug === "extra-guest")!;

    const refused = await book({ addons: [{ addonId: pet.id, quantity: 1 }] }); // Blanche only
    expect(refused).toMatchObject({ ok: false, status: 422, code: "invalid_price" });

    const ok = await book({
      studioIds: [ids.dayglow],
      durationMinutes: 60,
      addons: [
        { addonId: pet.id, quantity: 1 },
        { addonId: people.id, quantity: 4 },
      ],
    });
    expect(ok).toMatchObject({ ok: true, totalCents: 7800 + 4000 + 4 * 500 });
  });

  it("takes extra guests at $5 each, up to each studio's number, and every guest counts for studios together", async () => {
    const people = (await loadCatalog(db)).addons.find((a) => a.slug === "extra-guest")!;
    const guests = (quantity: number) => [{ addonId: people.id, quantity }];
    // Blanche: 6 extra. Paris: 4.
    expect(await book({ studioIds: [ids.blanche], addons: guests(6), startMinute: 9 * 60 })).toMatchObject({ ok: true, totalCents: 17600 + 3000 });
    expect(await book({ studioIds: [ids.blanche], addons: guests(7), startMinute: 12 * 60 })).toMatchObject({
      ok: false,
      status: 422,
      code: "invalid_price",
      message: "At most 6 extra guests can come with this booking.",
    });
    expect(await book({ studioIds: [ids.paris], addons: guests(5), startMinute: 12 * 60 })).toMatchObject({ ok: false, message: "At most 4 extra guests can come with this booking." });
    // Paris and Dayglow include 4 + 6 guests: the limit of 10 for two studios leaves none extra.
    expect(await book({ studioIds: [ids.paris, ids.dayglow], addons: guests(1), startMinute: 15 * 60, durationMinutes: 60 })).toMatchObject({
      ok: false,
      message: "No extra guests can come with this booking.",
    });
    // All three include 16: the limit of 20 leaves 4.
    expect(await book({ studioIds: [ids.blanche, ids.dayglow, ids.paris], addons: guests(5), startMinute: 17 * 60, durationMinutes: 60 })).toMatchObject({
      ok: false,
      message: "At most 4 extra guests can come with this booking.",
    });
    expect(await book({ studioIds: [ids.blanche, ids.dayglow, ids.paris], addons: guests(4), startMinute: 17 * 60, durationMinutes: 60 })).toMatchObject({ ok: true });
    // The owners raise the limit for two studios: Paris and Dayglow then take what is left above 10.
    await db.insert(settings).values({ key: "twoStudioGuestLimit", value: 13 });
    expect(await book({ studioIds: [ids.paris, ids.dayglow], addons: guests(3), startMinute: 15 * 60, durationMinutes: 60 })).toMatchObject({ ok: true });
  });
});

describe("weekday and weekend prices", () => {
  it("charges the approved weekend tiers on Saturday and Sunday and the weekday price on Wednesday", async () => {
    expect(await book({ date: SAT, durationMinutes: 60 })).toMatchObject({ ok: true, totalCents: 9500 });
    expect(await book({ date: "2026-11-22", durationMinutes: 90 })).toMatchObject({ ok: true, totalCents: 14250 });
    expect(await book({ date: WED, durationMinutes: 60 })).toMatchObject({ ok: true, totalCents: 8800 });
    expect(charges.map((charge) => charge.amountCents)).toEqual([9500, 14250, 8800]);
  });

  it("prices a holiday on a weekday as a weekend day", async () => {
    await db
      .update(priceRules)
      .set({ priceCents: 9900 })
      .where(and(eq(priceRules.studioId, ids.paris), eq(priceRules.dayType, "weekend"), eq(priceRules.durationMinutes, 60)));
    await db.insert(specialDates).values({ day: WED, dayType: "weekend", note: "Holiday" });
    expect(await book({ studioIds: [ids.paris], durationMinutes: 60 })).toMatchObject({ ok: true, totalCents: 9900 });
    await db
      .update(priceRules)
      .set({ priceCents: 7200 })
      .where(and(eq(priceRules.studioId, ids.paris), eq(priceRules.dayType, "weekend"), eq(priceRules.durationMinutes, 60)));
  });
});

describe("double booking is impossible", () => {
  it("refuses a second booking of the same studio and time", async () => {
    expect((await book()).ok).toBe(true);
    expect(await book()).toMatchObject({ ok: false, status: 409, code: "slot_taken" });
    expect(charges).toHaveLength(1);
  });

  it("refuses overlaps and keeps appointments at least 15 minutes apart, but allows other studios", async () => {
    expect((await book()).ok).toBe(true); // Blanche 10:00-12:00, kept free until 12:15
    expect(await book({ startMinute: h(11), durationMinutes: 60 })).toMatchObject({ code: "slot_taken" });
    expect(await book({ startMinute: h(9), durationMinutes: 60 })).toMatchObject({ code: "slot_taken" }); // ends 10:00, no gap before the next
    expect(await book({ startMinute: h(12), durationMinutes: 60 })).toMatchObject({ code: "slot_taken" }); // no gap after the last
    expect((await book({ startMinute: h(12) + 15, durationMinutes: 60 })).ok).toBe(true); // exactly 15 minutes later
    expect((await book({ studioIds: [ids.paris] })).ok).toBe(true); // other studio, same time
    // A bundle that includes the taken studio is refused as a whole.
    expect(await book({ studioIds: [ids.blanche, ids.dayglow, ids.paris], durationMinutes: 60 })).toMatchObject({ code: "slot_taken" });
    expect(await db.select().from(studioHolds).where(eq(studioHolds.studioId, ids.dayglow))).toHaveLength(0);
  });

  it("offers start times every 15 minutes, leaving out the ones that would come within 15 minutes of a booking", async () => {
    await book(); // Blanche 10:00-12:00
    const catalog = await loadCatalog(db);
    expect(catalog.settings.slotIncrementMinutes).toBe(15);
    expect(catalog.studios.map((studio) => studio.bufferMinutes)).toEqual([15, 15, 15]);

    const day = await loadDayAvailability(db, catalog, WED, NOW);
    const options = { durationMinutes: 60, incrementMinutes: 15, earliestStartMinute: day.earliestStartMinute };
    const blanche = freeStarts(day.days.find((d) => d.studioId === ids.blanche)!, options);
    // Nothing before the booking: 9:00 to 10:00 would leave no gap. Then every quarter of an hour from 12:15.
    expect(blanche.slice(0, 4)).toEqual([h(12) + 15, h(12) + 30, h(12) + 45, h(13)]);
    // Each studio has its own calendar: Paris is free from opening time.
    const paris = freeStarts(day.days.find((d) => d.studioId === ids.paris)!, options);
    expect(paris.slice(0, 3)).toEqual([h(9), h(9) + 15, h(9) + 30]);
  });

  it("lets only one of many simultaneous requests win, and charges only that one", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => book({ customer: { name: `Person ${i}`, email: `p${i}@example.com`, phone: "5550100100" } })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "slot_taken")).toHaveLength(7);
    expect(charges).toHaveLength(1);
    expect(await db.select().from(bookings).where(eq(bookings.status, "confirmed"))).toHaveLength(1);
  });

  it("refuses a second request that arrives while the first card is being charged", async () => {
    let nested: Awaited<ReturnType<typeof book>> | undefined;
    const slowProvider: PaymentProvider = {
      ...mockProvider,
      name: "mock",
      async charge(request) {
        // The exact interleaving that double-booked the old site.
        nested = await book({ customer: { name: "Second Customer", email: "second@example.com", phone: "5550100100" } });
        return countingProvider.charge(request);
      },
      refund: mockProvider.refund,
    };
    const first = await book({}, { payments: slowProvider });
    expect(first.ok).toBe(true);
    expect(nested).toMatchObject({ ok: false, code: "slot_taken" });
    expect(charges).toHaveLength(1);
  });

  it("is enforced by the database itself, even for code that skips the checks", async () => {
    const first = await book();
    expect(first.ok).toBe(true);
    const [existing] = await db.select().from(bookings);
    let code: string | undefined;
    try {
      await db.insert(studioHolds).values({
        studioId: ids.blanche,
        bookingId: existing.id,
        occupied: sql`tstzrange('2026-11-18T16:00:00Z'::timestamptz, '2026-11-18T16:30:00Z'::timestamptz, '[)')`,
      });
    } catch (error) {
      code = pgErrorCode(error);
    }
    expect(code).toBe("23P01");
  });
});

describe("payment", () => {
  it("releases the slot and confirms nothing when the card is declined", async () => {
    const declined = await book({ paymentToken: MOCK_TOKEN_DECLINED });
    expect(declined).toMatchObject({ ok: false, status: 402, code: "payment_failed" });
    const [row] = await db.select().from(bookings);
    expect(row.status).toBe("expired");
    expect((await db.select().from(studioHolds)).every((x) => !x.active)).toBe(true);
    expect((await db.select().from(payments))[0].status).toBe("failed");
    expect(await db.select().from(emailOutbox)).toHaveLength(0);
    expect((await book()).ok).toBe(true); // the slot is bookable again
  });

  it("says nothing was taken when the processor gave no answer: the card was at most reserved, and nobody has to check", async () => {
    const silent: PaymentProvider = {
      ...mockProvider,
      name: "square",
      charge: async () => ({
        ok: false,
        unknown: true,
        message: "We could not reach the card processor.",
        detail: "No answer from Square",
      }),
      refund: mockProvider.refund,
    };
    const result = await book({}, { payments: silent, ownerEmail: "owner@studio.test" });
    expect(result).toEqual({
      ok: false,
      status: 402,
      code: "payment_failed",
      message:
        "We could not reach the card processor. Your booking was not made, and your card was not charged. If an amount appears as held on your card, it is released by itself within 24 hours.",
    });

    const [row] = await db.select().from(bookings);
    expect(row.status).toBe("expired");
    expect((await db.select().from(payments))[0]).toMatchObject({ status: "failed", error: "No answer from Square" });
    expect(await db.select().from(emailOutbox)).toHaveLength(0);
    expect((await book()).ok).toBe(true); // the time is free again
  });

  it("reserves the amount, confirms the booking, and only then takes the money", async () => {
    const steps: string[] = [];
    const watching: PaymentProvider = {
      ...countingProvider,
      async charge(request) {
        steps.push(`reserve ${request.reserve === true}`);
        return countingProvider.charge(request);
      },
      async capture(paymentId) {
        // By the time the money is taken, the booking is confirmed and its payment recorded as reserved.
        const [booking] = await db.select().from(bookings);
        const [payment] = await db.select().from(payments);
        steps.push(`take while the booking is ${booking.status} and the payment ${payment.status}`);
        return mockProvider.capture(paymentId);
      },
    };
    const made = await book({}, { payments: watching });
    expect(made.ok).toBe(true);
    expect(steps).toEqual(["reserve true", "take while the booking is confirmed and the payment authorized"]);
    expect((await db.select().from(payments))[0]).toMatchObject({ status: "succeeded", error: null });
  });

  it("records the processor's own words for a refused card, and shows the customer a sentence", async () => {
    const refusing: PaymentProvider = {
      ...mockProvider,
      name: "square",
      charge: async () => ({
        ok: false,
        message: "The card's security code is not right.",
        detail: "CVV_FAILURE: Authorization error: 'CVV_FAILURE'",
      }),
      refund: mockProvider.refund,
    };
    const result = await book({}, { payments: refusing, ownerEmail: "owner@studio.test" });
    expect(result).toMatchObject({
      ok: false,
      message: "Payment failed: The card's security code is not right. Your card was not charged.",
    });
    expect((await db.select().from(payments))[0]).toMatchObject({
      status: "failed",
      error: "CVV_FAILURE: Authorization error: 'CVV_FAILURE'",
    });
    expect(await db.select().from(emailOutbox)).toHaveLength(0);
  });

  it("cannot be skipped by the browser", async () => {
    expect(await book({ paymentToken: undefined })).toMatchObject({ ok: false, status: 400, code: "payment_required" });
    expect(await book({ paymentToken: "anything-else" })).toMatchObject({ ok: false, code: "payment_failed" });
    const smuggled = { ...input(), paymentToken: undefined, payment_type: "none", totalCents: 0 };
    expect(await createBooking(db, smuggled, { now: NOW, payments: countingProvider, baseUrl: "x" })).toMatchObject({
      ok: false,
      code: "payment_required",
    });
    expect(await db.select().from(bookings).where(eq(bookings.status, "confirmed"))).toHaveLength(0);
  });

  it("refuses paid bookings when no processor is configured", async () => {
    expect(await book({}, { payments: null })).toMatchObject({ ok: false, status: 503, code: "payments_unavailable" });
    expect(await db.select().from(bookings)).toHaveLength(0);
  });

  it("stops before charging when the price differs from what the customer saw", async () => {
    expect(await book({ expectedTotalCents: 100 })).toMatchObject({ ok: false, status: 409, code: "price_changed" });
    expect(charges).toHaveLength(0);
    expect(await db.select().from(bookings)).toHaveLength(0);
    expect((await book({ expectedTotalCents: 17600 })).ok).toBe(true);
  });

  it("frees a slot whose payment was abandoned", async () => {
    const [stale] = await db
      .insert(bookings)
      .values({
        ref: "VS-STALE2",
        customerName: "Gone",
        customerEmail: "gone@example.com",
        startAt: new Date("2026-11-18T15:00:00Z"),
        endAt: new Date("2026-11-18T17:00:00Z"),
        durationMinutes: 120,
        status: "pending_payment",
        holdExpiresAt: new Date(NOW.getTime() - 60_000),
        studiosSubtotalCents: 17600,
        totalCents: 17600,
        manageTokenHash: "x",
        moneyKind: "test",
      })
      .returning({ id: bookings.id });
    await db.insert(studioHolds).values({
      studioId: ids.blanche,
      bookingId: stale.id,
      occupied: sql`tstzrange('2026-11-18T15:00:00Z'::timestamptz, '2026-11-18T17:10:00Z'::timestamptz, '[)')`,
    });
    expect((await book()).ok).toBe(true);
    const [after] = await db.select().from(bookings).where(eq(bookings.id, stale.id));
    expect(after.status).toBe("expired");
  });

  it("keeps a slot held while a payment is still in progress", async () => {
    const [pending] = await db
      .insert(bookings)
      .values({
        ref: "VS-PEND22",
        customerName: "Paying",
        customerEmail: "paying@example.com",
        startAt: new Date("2026-11-18T15:00:00Z"),
        endAt: new Date("2026-11-18T17:00:00Z"),
        durationMinutes: 120,
        status: "pending_payment",
        holdExpiresAt: new Date(NOW.getTime() + 5 * 60_000),
        studiosSubtotalCents: 17600,
        totalCents: 17600,
        manageTokenHash: "x",
        moneyKind: "test",
      })
      .returning({ id: bookings.id });
    await db.insert(studioHolds).values({
      studioId: ids.blanche,
      bookingId: pending.id,
      occupied: sql`tstzrange('2026-11-18T15:00:00Z'::timestamptz, '2026-11-18T17:10:00Z'::timestamptz, '[)')`,
    });
    expect(await book()).toMatchObject({ ok: false, code: "slot_taken" });
  });
});

/**
 * A booking whose answer never reached the screen (the connection dropped
 * after the card was charged): the screen sends the same attempt again, and
 * is told what became of it. Nothing is booked or charged twice.
 */
describe("an attempt to book sent again", () => {
  const attempt = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

  it("finds the booking it made, charged once, with a link that opens it", async () => {
    const first = await book({ requestId: attempt });
    expect(first.ok).toBe(true);
    // The screen got no answer, and sends the same attempt again: a new card token, the same id.
    const again = await book({ requestId: attempt, paymentToken: MOCK_TOKEN_OK });
    expect(again).toMatchObject({ ok: true, ref: first.ok && first.ref, totalCents: first.ok && first.totalCents });
    expect(charges).toHaveLength(1);
    expect(await db.select().from(bookings)).toHaveLength(1);
    // Both links open the booking: the one of the confirmation email, and the second one the screen was given.
    expect(await getBookingByToken(db, first.ok ? first.ref : "", first.ok ? first.manageToken : "")).not.toBeNull();
    expect(await getBookingByToken(db, again.ok ? again.ref : "", again.ok ? again.manageToken : "")).not.toBeNull();
    expect(again.ok && first.ok && again.manageToken !== first.manageToken).toBe(true);
    // Only a hash of the attempt's id is kept, never the id itself.
    const [row] = await db.select().from(bookings);
    expect(row.requestKey).toBe(hashToken(`request:${attempt}`));
    expect(JSON.stringify(row)).not.toContain(attempt);
  });

  it("is over when it did not go through: the next press books anew", async () => {
    expect(await book({ requestId: attempt, paymentToken: MOCK_TOKEN_DECLINED })).toMatchObject({ ok: false, code: "payment_failed" });
    // Told what the first answer told: the card was not charged.
    expect(await book({ requestId: attempt })).toMatchObject({
      ok: false,
      status: 409,
      code: "attempt_over",
      message: "That attempt did not make a booking, and your card was not charged. If an amount appears as held on your card, it is released by itself within 24 hours. Please try again.",
    });
    expect(charges).toHaveLength(0);
    // A new attempt, with an id of its own, books the time.
    expect(await book({ requestId: "0b2c4d6e-8f10-4a2b-9c3d-4e5f6a7b8c9d" })).toMatchObject({ ok: true });
    expect(charges).toHaveLength(1);
  });

  it("is asked to wait while the first is still on its way", async () => {
    // The first press is between holding the time and confirming it.
    const slow: PaymentProvider = { ...countingProvider, charge: () => new Promise(() => {}) };
    void book({ requestId: attempt }, { payments: slow });
    await expect.poll(async () => (await db.select().from(bookings)).length).toBe(1);
    expect(await book({ requestId: attempt })).toMatchObject({ ok: false, status: 409, code: "in_progress" });
    expect(charges).toHaveLength(0);
  });

  it("is over when it is sent for something else", async () => {
    expect((await book({ requestId: attempt })).ok).toBe(true);
    expect(await book({ requestId: attempt, startMinute: h(14) })).toMatchObject({ ok: false, code: "attempt_over" });
    expect(await book({ requestId: attempt, studioIds: [ids.paris] })).toMatchObject({ ok: false, code: "attempt_over" });
    expect(charges).toHaveLength(1);
  });

  it("does not stand in the way of a booking without one", async () => {
    expect((await book()).ok).toBe(true);
    expect((await book({ startMinute: h(14) })).ok).toBe(true);
  });
});

describe("bad input is refused", () => {
  const cases: [string, Partial<BookingInput>, string][] = [
    ["negative duration", { durationMinutes: -60 }, "invalid_input"],
    ["six-minute booking", { durationMinutes: 6 }, "invalid_price"],
    ["duration with no price", { durationMinutes: 150 }, "invalid_price"],
    ["fractional duration", { durationMinutes: 60.5 }, "invalid_input"],
    ["date in the past", { date: "2026-11-10" }, "not_bookable_date"],
    ["impossible date", { date: "2026-02-30" }, "not_bookable_date"],
    ["date too far ahead", { date: "2028-01-05" }, "not_bookable_date"],
    ["inside the 24-hour notice", { date: "2026-11-15", startMinute: h(9), durationMinutes: 60 }, "slot_taken"],
    ["start off the slot grid", { startMinute: h(10) + 7 }, "slot_taken"],
    ["before opening", { startMinute: h(7) }, "slot_taken"],
    ["running past closing", { startMinute: h(18), durationMinutes: 120 }, "slot_taken"],
    ["no studios", { studioIds: [] }, "invalid_input"],
    ["unknown studio", { studioIds: ["3f2c1e9a-6b7d-4c8e-9f10-112233445566"] }, "unknown_studio"],
    ["terms not accepted", { acceptTerms: false as unknown as true }, "invalid_input"],
    ["bad email", { customer: { name: "A B", email: "not-an-email", phone: "5550100100" } }, "invalid_input"],
    ["missing phone", { customer: { name: "A B", email: "a@example.com", phone: "" } }, "invalid_input"],
  ];
  for (const [name, overrides, code] of cases) {
    it(name, async () => {
      const result = await book(overrides);
      expect(result).toMatchObject({ ok: false, code });
      expect(charges).toHaveLength(0);
      expect(await db.select().from(bookings).where(eq(bookings.status, "confirmed"))).toHaveLength(0);
    });
  }

  it("names a field the customer typed in the words of the screen", async () => {
    // An address the booking's own rule refuses: the rule every email field follows (src/lib/parse.ts).
    expect(await book({ customer: { name: "A B", email: "kim..lee@example.com", phone: "5550100100" } })).toMatchObject({
      ok: false,
      message: "Please check the email address: it does not look like one.",
    });
    expect(await book({ customer: { name: "A B", email: "a@example.com", phone: "" } })).toMatchObject({
      ok: false,
      message: "Please check the phone number: from 7 to 40 characters.",
    });
    expect(await book({ notes: "x".repeat(2001) })).toMatchObject({ ok: false, message: "Please make the notes shorter: at most 2,000 characters." });
  });

  it("a character the database cannot store, which is dropped instead of failing the request", async () => {
    const result = await book({ customer: { name: "Jane\u0000 Smith", email: "jane@example.com", phone: "407-555-0100" }, notes: "Bring\u0000 props\r\nand lights" });
    expect(result).toMatchObject({ ok: true });
    expect((await db.select().from(bookings))[0]).toMatchObject({ customerName: "Jane Smith", notes: "Bring props\nand lights" });
    // A code is looked up in the database too.
    expect(await book({ startMinute: h(14), promoCode: "MOVE\u0000-1234" })).toMatchObject({ ok: false, code: "invalid_code" });
  });

  it("the same studio listed twice", async () => {
    expect(await book({ studioIds: [ids.blanche, ids.blanche] })).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("allows a booking just outside the notice period", async () => {
    // Now is Saturday 10:00, so Sunday 10:00 is exactly 24 hours ahead.
    expect((await book({ date: "2026-11-15", startMinute: h(10), durationMinutes: 60 })).ok).toBe(true);
  });
});

describe("opening hours", () => {
  it("offers nothing on a day the owner marked closed", async () => {
    const MON = "2026-11-16";
    await db.delete(studioHours).where(and(eq(studioHours.studioId, ids.blanche), eq(studioHours.weekday, 1)));
    const catalog = await loadCatalog(db);
    const day = await loadDayAvailability(db, catalog, MON, NOW);
    const blanche = day.days.filter((d) => d.studioId === ids.blanche);
    expect(combinedStarts(blanche, { durationMinutes: 60, incrementMinutes: 30 })).toEqual([]);
    expect(await book({ date: MON })).toMatchObject({ ok: false, code: "slot_taken" });
    expect((await book({ date: MON, studioIds: [ids.paris] })).ok).toBe(true);
    await db.insert(studioHours).values({ studioId: ids.blanche, weekday: 1, openMinute: h(9), closeMinute: h(19) });
  });

  it("reports taken time in studio-local minutes", async () => {
    await book();
    const catalog = await loadCatalog(db);
    const day = await loadDayAvailability(db, catalog, WED, NOW);
    const blanche = day.days.find((d) => d.studioId === ids.blanche)!;
    expect(blanche.busy).toEqual([{ start: h(10), end: h(12) + 15 }]);
    expect(blanche.openMinute).toBe(h(9));
    expect(day.dayType).toBe("weekday");
  });

  it("neither offers nor books the hour the clocks skip, in a studio open all night", async () => {
    await db.insert(settings).values({ key: "maxAdvanceDays", value: 365 });
    await db.delete(studioHours).where(and(eq(studioHours.studioId, ids.blanche), eq(studioHours.weekday, 7)));
    await db.insert(studioHours).values({ studioId: ids.blanche, weekday: 7, openMinute: 0, closeMinute: 1440 });
    const SPRING = "2027-03-14"; // a Sunday: the clocks go from 2:00 to 3:00
    const catalog = await loadCatalog(db);
    const day = await loadDayAvailability(db, catalog, SPRING, NOW);
    const blanche = day.days.filter((d) => d.studioId === ids.blanche);
    const starts = combinedStarts(blanche, { durationMinutes: 60, incrementMinutes: 15 });
    // 2:00 does not exist, and a visit from 1:00 or 1:30 would run into it: none of them is offered.
    for (const minute of [h(1), h(1) + 30, h(2), h(2) + 30]) expect(starts).not.toContain(minute);
    expect(starts).toContain(h(3));
    // Sent anyway, they are refused with a reason, not a server error, and nothing is charged.
    for (const startMinute of [h(2), h(1)]) {
      expect(await book({ date: SPRING, startMinute, durationMinutes: startMinute === h(1) ? 120 : 60 })).toMatchObject({ ok: false, code: "slot_taken" });
    }
    expect(await db.select().from(bookings)).toHaveLength(0);
    expect((await book({ date: SPRING, startMinute: h(3), durationMinutes: 60 })).ok).toBe(true);
  });

  it("converts local time correctly on a daylight-saving change day", async () => {
    await db.insert(settings).values({ key: "maxAdvanceDays", value: 365 });
    // Sunday 2027-03-14: clocks jump from 2:00 to 3:00, so 10:00 is UTC-4.
    const result = await book({ date: "2027-03-14", durationMinutes: 60 });
    expect(result.ok).toBe(true);
    const [row] = await db.select().from(bookings);
    expect(row.startAt.toISOString()).toBe("2027-03-14T14:00:00.000Z");
  });
});

describe("viewing a booking", () => {
  it("needs the secret from the customer's link", async () => {
    const result = await book({ studioIds: [ids.blanche, ids.paris], durationMinutes: 60 });
    if (!result.ok) throw new Error("setup failed");
    const view = await getBookingByToken(db, result.ref, result.manageToken);
    expect(view).toMatchObject({ ref: result.ref, status: "confirmed", totalCents: result.totalCents });
    expect(view!.studios.map((s) => s.name)).toEqual(["Studio Blanche", "Studio Paris"]);
    expect(await getBookingByToken(db, result.ref, "wrong-token-wrong-token-wrong")).toBeNull();
    expect(await getBookingByToken(db, "VS-AAAAAA", result.manageToken)).toBeNull();
    expect(await getBookingByToken(db, "'; drop table bookings; --", result.manageToken)).toBeNull();
  });
});

describe("a date far beyond the horizon", () => {
  it("is too far ahead, as any date past the horizon, and not a failure of the database", async () => {
    const catalog = await loadCatalog(db);
    for (const date of ["9999-12-31", "9999-12-30", "2400-02-29"]) {
      expect(await loadDayAvailability(db, catalog, date, NOW)).toMatchObject({ problem: "too_far" });
    }
    expect(await loadDayAvailability(db, catalog, "9999-12-31", NOW, { withPhotographer: true })).toMatchObject({ problem: "too_far" });
    expect(await book({ date: "9999-12-31" })).toMatchObject({ ok: false, code: "not_bookable_date" });
  });
});
