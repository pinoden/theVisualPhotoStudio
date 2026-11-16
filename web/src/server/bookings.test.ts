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
import { createBooking, getBookingByToken, hashToken, type BookingInput } from "./bookings";
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

  it("books any combination of studios in one booking with the multi-studio discount", async () => {
    // Blanche + Dayglow does not exist as a bundle on the current site.
    const result = await book({ studioIds: [ids.blanche, ids.dayglow], durationMinutes: 60 });
    expect(result).toMatchObject({ ok: true, totalCents: 13280 }); // ($88 + $78) less 20%
    const holds = await db.select().from(studioHolds);
    expect(holds.map((x) => x.studioId).sort()).toEqual([ids.blanche, ids.dayglow].sort());
    expect(holds.every((x) => x.active)).toBe(true);

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
    const people = catalog.addons.find((a) => a.slug === "extra-people-1-2")!;

    const refused = await book({ addons: [{ addonId: pet.id, quantity: 1 }] }); // Blanche only
    expect(refused).toMatchObject({ ok: false, status: 422, code: "invalid_price" });

    const ok = await book({
      studioIds: [ids.dayglow],
      durationMinutes: 60,
      addons: [
        { addonId: pet.id, quantity: 1 },
        { addonId: people.id, quantity: 1 },
      ],
    });
    expect(ok).toMatchObject({ ok: true, totalCents: 7800 + 4000 + 3000 });
  });
});

describe("weekday and weekend prices", () => {
  it("charges the weekend price on Saturday and the weekday price on Wednesday", async () => {
    await db
      .update(priceRules)
      .set({ priceCents: 11000 })
      .where(and(eq(priceRules.studioId, ids.blanche), eq(priceRules.dayType, "weekend"), eq(priceRules.durationMinutes, 60)));
    expect(await book({ date: SAT, durationMinutes: 60 })).toMatchObject({ ok: true, totalCents: 11000 });
    expect(await book({ date: WED, durationMinutes: 60 })).toMatchObject({ ok: true, totalCents: 8800 });
    await db
      .update(priceRules)
      .set({ priceCents: 8800 })
      .where(and(eq(priceRules.studioId, ids.blanche), eq(priceRules.dayType, "weekend"), eq(priceRules.durationMinutes, 60)));
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
      .set({ priceCents: 6800 })
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
    expect(await book({ studioIds: [ids.blanche, ids.dayglow], durationMinutes: 60 })).toMatchObject({ code: "slot_taken" });
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

  it("does not claim the card was spared when the processor gave no answer, and asks the owner to check", async () => {
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
        "We could not reach the card processor. Your booking was not made. We cannot tell whether your card was charged: if a charge appears, contact us and we will refund it.",
    });

    const [row] = await db.select().from(bookings);
    expect(row.status).toBe("expired");
    expect((await db.select().from(payments))[0]).toMatchObject({ status: "failed", error: "No answer from Square" });
    const mail = await db.select().from(emailOutbox);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({
      toEmail: "owner@studio.test",
      kind: "owner_payment_unknown",
      subject: `ACTION NEEDED: check a payment for ${row.ref}`,
    });
    expect(mail[0].body).toContain(`A card payment of $176 for booking ${row.ref} (Test Person) got no answer from Square.`);
    expect((await book()).ok).toBe(true); // the time is free again
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
    expect(await book({ requestId: attempt })).toMatchObject({ ok: false, status: 409, code: "attempt_over" });
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
