import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookings, payments, promoCodes } from "@/db/schema";
import { quoteSelection } from "./bookings";
import { MOCK_TOKEN_DECLINED } from "./payments";
import { findUsablePromo, issuePromo, normalizeCode } from "./promos";
import { createTestWorld, daysAfter, expectOk, FAR, h, NEAR, NOW, type TestWorld } from "./testing";

let world: TestWorld;
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(() => world.reset());

const JANE = "jane@example.com";

async function percentCode(percent = 10, overrides: Partial<Parameters<typeof issuePromo>[1]> = {}) {
  const issued = await issuePromo(world.db, {
    kind: "percent",
    value: percent,
    source: "loyalty",
    email: JANE,
    expiresAt: daysAfter(NOW, 60),
    ...overrides,
  });
  return issued!;
}

async function creditCode(cents: number, overrides: Partial<Parameters<typeof issuePromo>[1]> = {}) {
  const issued = await issuePromo(world.db, {
    kind: "amount",
    value: cents,
    source: "reschedule",
    email: JANE,
    expiresAt: daysAfter(NOW, 90),
    maxUses: 1_000_000,
    rescheduleGeneration: 1,
    ...overrides,
  });
  return issued!;
}

const codeRow = async (id: string) => (await world.db.select().from(promoCodes).where(eq(promoCodes.id, id)))[0];

describe("a discount code", () => {
  it("takes its percentage off the rental and can be used once", async () => {
    const promo = await percentCode(10);
    const first = expectOk(await world.book({ promoCode: promo.code }));
    expect(first.totalCents).toBe(15840); // $176 less 10%
    expect(world.charges.at(-1)?.amountCents).toBe(15840);

    const [row] = await world.db.select().from(bookings).where(eq(bookings.ref, first.ref));
    expect(row).toMatchObject({ promoDiscountCents: 1760, creditAppliedCents: 0, rescheduledCount: 0, promoCodeId: promo.id });
    expect((await codeRow(promo.id)).usedCount).toBe(1);

    const again = await world.book({ promoCode: promo.code, startMinute: h(14) });
    expect(again).toMatchObject({ ok: false, status: 422, code: "invalid_code", message: "That code has already been used." });
  });

  it("does not discount add-ons", async () => {
    const promo = await percentCode(10);
    const catalogAddons = (await import("./catalog")).loadCatalog(world.db);
    const pet = (await catalogAddons).addons.find((a) => a.slug === "pet-fee")!;
    const result = expectOk(
      await world.book({ studioIds: [world.ids.dayglow], durationMinutes: 60, addons: [{ addonId: pet.id, quantity: 1 }], promoCode: promo.code }),
    );
    expect(result.totalCents).toBe(7800 - 780 + 4000);
  });

  it("is typed in any case, with or without spaces", async () => {
    const promo = await percentCode(10);
    expect(normalizeCode(`  ${promo.code.toLowerCase()} `)).toBe(promo.code);
    expect((await world.book({ promoCode: ` ${promo.code.toLowerCase()} ` })).ok).toBe(true);
  });

  it("works only for the email address it was sent to", async () => {
    const promo = await percentCode(10);
    const result = await world.book({ promoCode: promo.code, customer: { name: "Eve", email: "eve@example.com", phone: "5550100100" } });
    expect(result).toMatchObject({ ok: false, code: "invalid_code" });
    expect(!result.ok && result.message).toContain("different email address");
    expect(await world.db.select().from(bookings)).toHaveLength(0);
    expect(world.charges).toHaveLength(0);
  });

  it("is refused when expired, cancelled by the owner or unknown", async () => {
    const expired = await percentCode(10, { expiresAt: daysAfter(NOW, -1) });
    expect(await world.book({ promoCode: expired.code })).toMatchObject({ ok: false, message: "That code has expired." });

    const voided = await percentCode(10);
    await world.db.update(promoCodes).set({ voidedAt: NOW }).where(eq(promoCodes.id, voided.id));
    expect(await world.book({ promoCode: voided.code })).toMatchObject({ ok: false, message: "That code is not valid." });

    expect(await world.book({ promoCode: "THANKS-NOPE-NOPE" })).toMatchObject({ ok: false, message: "That code is not valid." });
    expect(await world.db.select().from(bookings)).toHaveLength(0);
  });

  it("becomes usable again when the card is declined", async () => {
    const promo = await percentCode(10);
    expect(await world.book({ promoCode: promo.code, paymentToken: MOCK_TOKEN_DECLINED })).toMatchObject({ ok: false, code: "payment_failed" });
    expect((await codeRow(promo.id)).usedCount).toBe(0);
    expect((await world.book({ promoCode: promo.code })).ok).toBe(true);
  });

  it("cannot be spent twice by two bookings made at the same moment", async () => {
    const promo = await percentCode(10);
    const results = await Promise.all([
      world.book({ promoCode: promo.code, studioIds: [world.ids.blanche] }),
      world.book({ promoCode: promo.code, studioIds: [world.ids.paris] }),
      world.book({ promoCode: promo.code, studioIds: [world.ids.dayglow] }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "invalid_code")).toHaveLength(2);
    expect((await codeRow(promo.id)).usedCount).toBe(1);
    expect(world.charges).toHaveLength(1);
    // The losers left no bookings and no held slots behind.
    expect(await world.db.select().from(bookings).where(eq(bookings.status, "confirmed"))).toHaveLength(1);
    expect(await world.db.select().from(bookings)).toHaveLength(1);
  });

  it("stops the booking if the total differs from what the customer saw", async () => {
    const promo = await percentCode(10);
    expect(await world.book({ promoCode: promo.code, expectedTotalCents: 17600 })).toMatchObject({ ok: false, code: "price_changed" });
    expect((await codeRow(promo.id)).usedCount).toBe(0);
    expect((await world.book({ promoCode: promo.code, expectedTotalCents: 15840 })).ok).toBe(true);
  });
});

describe("a credit code", () => {
  it("pays for a booking of the same price, with no card needed", async () => {
    const credit = await creditCode(17600);
    const result = expectOk(await world.book({ promoCode: credit.code, paymentToken: undefined }));
    expect(result.totalCents).toBe(0);
    expect(world.charges).toHaveLength(0);
    expect(await world.db.select().from(payments)).toHaveLength(0);

    const [row] = await world.db.select().from(bookings);
    expect(row).toMatchObject({ status: "confirmed", totalCents: 0, promoDiscountCents: 17600, creditAppliedCents: 17600 });
    expect((await codeRow(credit.id)).value).toBe(0);
    expect(await world.book({ promoCode: credit.code, startMinute: h(14) })).toMatchObject({ ok: false, message: "That code has already been used." });
  });

  it("marks the new booking as moved, so it cannot be refunded", async () => {
    const credit = await creditCode(17600, { rescheduleGeneration: 2 });
    expectOk(await world.book({ promoCode: credit.code, paymentToken: undefined }));
    expect((await world.db.select().from(bookings))[0].rescheduledCount).toBe(2);
  });

  it("covers part of a dearer booking; the card pays the difference", async () => {
    const credit = await creditCode(8800);
    const result = expectOk(await world.book({ promoCode: credit.code, expectedTotalCents: 8800 })); // $176 booking
    expect(result.totalCents).toBe(8800);
    expect(world.charges.at(-1)?.amountCents).toBe(8800);
    expect((await world.db.select().from(bookings))[0]).toMatchObject({ creditAppliedCents: 8800, totalCents: 8800 });
    expect((await codeRow(credit.id)).value).toBe(0);
  });

  it("keeps what is left over for another booking", async () => {
    const credit = await creditCode(20000);
    expectOk(await world.book({ promoCode: credit.code, durationMinutes: 60, paymentToken: undefined })); // $88
    expect((await codeRow(credit.id)).value).toBe(11200);
    const second = expectOk(await world.book({ promoCode: credit.code, startMinute: h(14) })); // $176, $112 from the code
    expect(second.totalCents).toBe(6400);
    expect((await codeRow(credit.id)).value).toBe(0);
  });

  it("pays for add-ons too", async () => {
    const credit = await creditCode(50000);
    const { loadCatalog } = await import("./catalog");
    const people = (await loadCatalog(world.db)).addons.find((a) => a.slug === "extra-people-1-2")!;
    const result = expectOk(await world.book({ promoCode: credit.code, addons: [{ addonId: people.id, quantity: 1 }], paymentToken: undefined }));
    expect(result.totalCents).toBe(0);
    expect((await codeRow(credit.id)).value).toBe(50000 - 17600 - 3000);
  });

  it("gets its money back when the card for the difference is declined", async () => {
    const credit = await creditCode(8800);
    expect(await world.book({ promoCode: credit.code, paymentToken: MOCK_TOKEN_DECLINED })).toMatchObject({ ok: false, code: "payment_failed" });
    expect(await codeRow(credit.id)).toMatchObject({ value: 8800, usedCount: 0 });
  });

  it("cannot be overspent by two bookings made at the same moment", async () => {
    const credit = await creditCode(17600);
    const results = await Promise.all([
      world.book({ promoCode: credit.code, studioIds: [world.ids.blanche], paymentToken: undefined }),
      world.book({ promoCode: credit.code, studioIds: [world.ids.blanche], date: FAR, paymentToken: undefined }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await codeRow(credit.id)).value).toBe(0);
    expect(await world.db.select().from(bookings).where(eq(bookings.status, "confirmed"))).toHaveLength(1);
  });
});

describe("checking a code before paying", () => {
  const selection = () => ({ studioIds: [world.ids.blanche], date: NEAR, durationMinutes: 120 });

  it("returns the server's price with the code applied, and changes nothing", async () => {
    const promo = await percentCode(10);
    const result = expectOk(await quoteSelection(world.db, { ...selection(), promoCode: promo.code, email: JANE }, NOW));
    expect(result.quote.totalCents).toBe(15840);
    expect(result.promo).toEqual({ code: promo.code, kind: "percent", value: 10, source: "loyalty", photographyOnly: false });
    expect((await codeRow(promo.id)).usedCount).toBe(0);
  });

  it("explains what is wrong with a code", async () => {
    const promo = await percentCode(10);
    expect(await quoteSelection(world.db, { ...selection(), promoCode: promo.code }, NOW)).toMatchObject({
      ok: false,
      code: "invalid_code",
      message: "Enter your email address first, then apply the code.",
    });
    expect(await quoteSelection(world.db, { ...selection(), promoCode: promo.code, email: "eve@example.com" }, NOW)).toMatchObject({
      ok: false,
      code: "invalid_code",
    });
    expect(await quoteSelection(world.db, { ...selection(), promoCode: "NOPE", email: JANE }, NOW)).toMatchObject({
      ok: false,
      message: "That code is not valid.",
    });
  });

  it("prices a selection without a code, and refuses selections that have no price", async () => {
    expect(expectOk(await quoteSelection(world.db, selection(), NOW)).quote.totalCents).toBe(17600);
    expect(await quoteSelection(world.db, { ...selection(), durationMinutes: 150 }, NOW)).toMatchObject({ ok: false, code: "invalid_price" });
    expect(await quoteSelection(world.db, { ...selection(), date: "2026-02-30" }, NOW)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await quoteSelection(world.db, { studioIds: [] }, NOW)).toMatchObject({ ok: false, code: "invalid_input" });
  });
});

describe("issuing codes", () => {
  it("creates at most one code per booking and kind, however often it is asked", async () => {
    const booked = expectOk(await world.book());
    const [row] = await world.db.select().from(bookings).where(eq(bookings.ref, booked.ref));
    const first = await percentCode(10, { originBookingId: row.id });
    const second = await issuePromo(world.db, {
      kind: "percent",
      value: 10,
      source: "loyalty",
      email: JANE,
      expiresAt: null,
      originBookingId: row.id,
    });
    expect(first.code).toMatch(/^THANKS-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(second).toBeNull();
    // A different kind of code for the same booking is still allowed.
    expect(await creditCode(100, { originBookingId: row.id })).not.toBeNull();
    expect(await world.db.select().from(promoCodes)).toHaveLength(2);
  });

  it("finds a code only for its owner while it is live", async () => {
    const promo = await percentCode(10);
    expect((await findUsablePromo(world.db, promo.code, JANE, NOW)).ok).toBe(true);
    expect(await findUsablePromo(world.db, promo.code, JANE, daysAfter(NOW, 61))).toEqual({ ok: false, problem: "expired" });
    expect(await findUsablePromo(world.db, promo.code, "eve@example.com", NOW)).toEqual({ ok: false, problem: "wrong_email" });
    expect(await findUsablePromo(world.db, "", JANE, NOW)).toEqual({ ok: false, problem: "not_found" });
    expect(await findUsablePromo(world.db, 12345, JANE, NOW)).toEqual({ ok: false, problem: "not_found" });
  });
});
