import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import { eq } from "drizzle-orm";
import { addons, bookings, payments, priceRules, refunds } from "@/db/schema";
import { DEFAULT_FRAME } from "@/lib/site/frame";
import { createAdminBooking } from "./appointments";
import type { AuthUser } from "./auth";
import { cancelBooking, checkUnsettledRefunds, ownerRefund, requestRescheduleCode } from "./manage";
import { money, pdfSafe, receiptPdf, yearPdf } from "./receipt-pdf";
import { getReceipt, loadReceipts, transactionsOf, yearsOf, yearStatement } from "./receipts";
import { recordHandRefund, recordStudioPayment } from "./studio-payments";
import { BASE_URL, createTestWorld, daysAfter, expectOk, FAR, h, NEAR, NOW, type TestWorld } from "./testing";

/**
 * The owner's client portal, "Receipts & Payments": receipts by date with the
 * appointment, the studio, what was paid, discounts and the payment status;
 * refunds and partial refunds; a summary for each calendar year; and
 * "historical receipts must reflect the actual original transaction amounts,
 * not current studio pricing".
 */
let world: TestWorld;
let owner: AuthUser;

beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser("owner@studio.test", "owner", "Olivia");
});

const JANE = "jane@example.com";
const byToken = (token: string) => ({ kind: "token", token }) as const;
const receiptsOf = async (email = JANE) => (await loadReceipts(world.db, email)).receipts;

describe("a receipt", () => {
  it("shows what was booked at the price it was booked at, and the payment that was made", async () => {
    const booked = expectOk(await world.book()); // Blanche, two hours, $176
    const [receipt] = await receiptsOf();
    expect(receipt).toMatchObject({
      ref: booked.ref,
      customerName: "Jane Smith",
      customerEmail: JANE,
      visitStart: "2026-11-18T15:00:00.000Z",
      durationMinutes: 120,
      studios: "Studio Blanche",
      photography: false,
      bookingStatus: "Confirmed",
      lines: [{ label: "Studio Blanche", cents: 17600 }],
      totalCents: 17600,
      paidCents: 17600,
      refundedCents: 0,
      netCents: 17600,
      dueCents: 0,
      status: "paid",
    });
    expect(receipt.payments).toHaveLength(1);
    expect(receipt.payments[0]).toMatchObject({ how: "Card, online", amountCents: 17600, refunds: [] });
    expect(await getReceipt(world.db, JANE, booked.ref)).toEqual(receipt);
  });

  it("keeps the amounts of the day it was paid, whatever the studio charges now", async () => {
    const petFee = (await world.db.select().from(addons).where(eq(addons.slug, "pet-fee")))[0];
    const booked = expectOk(await world.book({ studioIds: [world.ids.dayglow], durationMinutes: 60, addons: [{ addonId: petFee.id, quantity: 1 }] }));
    const before = await getReceipt(world.db, JANE, booked.ref);
    expect(before).toMatchObject({ totalCents: 11800, lines: [{ label: "Studio Dayglow", cents: 7800 }, { label: "Pet fee", cents: 4000 }] });

    // The owner doubles every price, renames the add-on and charges more for it.
    await world.db.update(priceRules).set({ priceCents: 99900 });
    await world.db.update(addons).set({ name: "Animal guest", priceCents: 9900 }).where(eq(addons.id, petFee.id));
    expect(await getReceipt(world.db, JANE, booked.ref)).toEqual(before);
  });

  it("lists a discount, several studios, and money moved from an earlier booking as lines of their own", async () => {
    const bundle = expectOk(await world.book({ date: FAR, studioIds: [world.ids.blanche, world.ids.paris], durationMinutes: 60 }));
    expect((await getReceipt(world.db, JANE, bundle.ref))!.lines).toEqual([
      { label: "Studio Blanche", cents: 8800 },
      { label: "Studio Paris", cents: 6800 },
      { label: "Discount for booking several studios", cents: -3120 },
    ]);

    // The bundle is moved: its $124.80 becomes a credit, which pays part of a dearer booking.
    const credit = expectOk(await requestRescheduleCode(world.db, bundle.ref, byToken(bundle.manageToken), world.manageDeps()));
    const next = expectOk(await world.book({ date: "2026-12-10", promoCode: credit.code })); // $176
    const receipt = (await getReceipt(world.db, JANE, next.ref))!;
    expect(receipt.lines).toEqual([
      { label: "Studio Blanche", cents: 17600 },
      { label: "Paid with reschedule code", cents: -12480 },
    ]);
    expect(receipt).toMatchObject({ totalCents: 5120, paidCents: 5120, status: "paid" });
    // The first booking was paid for in full, and that payment was not refunded: it still has its receipt.
    expect(await getReceipt(world.db, JANE, bundle.ref)).toMatchObject({ paidCents: 12480, refundedCents: 0, bookingStatus: "Released for rescheduling" });
  });

  it("shows a refund, a partial refund, and one that is still on its way", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    expectOk(await ownerRefund(world.db, booked.ref, { amountCents: 2000, reason: "Lights failed for a while" }, world.manageDeps()));
    let receipt = (await getReceipt(world.db, JANE, booked.ref))!;
    expect(receipt).toMatchObject({ paidCents: 17600, refundedCents: 2000, netCents: 15600, status: "partly_refunded" });
    expect(receipt.payments[0].refunds).toMatchObject([{ amountCents: 2000, pending: false, reason: "Lights failed for a while" }]);

    // The customer cancels in time. The processor is down, so the refund is recorded and waits.
    world.failRefunds = "Square is not answering";
    expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    receipt = (await getReceipt(world.db, JANE, booked.ref))!;
    expect(receipt.bookingStatus).toBe("Cancelled");
    expect(receipt.payments[0].refunds.map((refund) => [refund.amountCents, refund.pending])).toEqual([
      [2000, false],
      [14820, true], // what was left, less the 5% fee
    ]);
    expect(receipt).toMatchObject({ refundedCents: 16820, netCents: 780, status: "partly_refunded" });
  });

  it("leaves out a refund the processor accepted and then rejected: that money did not go back", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    // Accepted, not completed yet: on its way.
    world.pendingRefunds = true;
    expectOk(await ownerRefund(world.db, booked.ref, { amountCents: 5000, reason: "Goodwill" }, world.manageDeps()));
    expect(await getReceipt(world.db, JANE, booked.ref)).toMatchObject({ refundedCents: 5000, status: "partly_refunded" });
    // Then rejected. A retry is answered the same way, so the receipt does not show it as on its way.
    world.refundAnswer = { state: "rejected", message: "The card account is closed" };
    expect(await checkUnsettledRefunds(world.db, world.manageDeps())).toEqual({ settled: 0, rejected: 1 });
    const receipt = (await getReceipt(world.db, JANE, booked.ref))!;
    expect(receipt).toMatchObject({ paidCents: 17600, refundedCents: 0, netCents: 17600, status: "paid" });
    expect(receipt.payments[0].refunds).toEqual([]);
  });

  it("says Refunded when everything paid was given back", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    expectOk(await ownerRefund(world.db, booked.ref, { amountCents: 17600, reason: "Studio closed" }, world.manageDeps()));
    expect(await getReceipt(world.db, JANE, booked.ref)).toMatchObject({ status: "refunded", netCents: 0 });
  });

  it("is made from payment records only: a booking with no payment has no receipt", async () => {
    // A booking made in the admin, not paid yet: an amount to pay, never a receipt.
    const made = expectOk(
      await createAdminBooking(
        world.db,
        owner,
        { studioIds: [world.ids.paris], date: NEAR, startMinute: h(14), durationMinutes: 60, customer: { name: "Jane Smith", email: JANE, phone: "407-555-0100" } },
        { now: NOW, baseUrl: BASE_URL },
      ),
    );
    expect(await loadReceipts(world.db, JANE)).toEqual({
      receipts: [],
      unpaid: [{ ref: made.ref, visitStart: "2026-11-18T19:00:00.000Z", studios: "Studio Paris", dueCents: 6800 }],
    });
    expect(await getReceipt(world.db, JANE, made.ref)).toBeNull();

    // Half is paid in cash: now there is a receipt, for what was paid, and it says the rest is still owed.
    expectOk(await recordStudioPayment(world.db, owner, made.ref, { amountCents: 3000, method: "cash", note: "" }, NOW));
    const { receipts, unpaid } = await loadReceipts(world.db, JANE);
    expect(unpaid).toEqual([]);
    expect(receipts[0]).toMatchObject({ paidCents: 3000, dueCents: 3800, status: "partly_paid", totalCents: 6800 });
    expect(receipts[0].payments[0].how).toBe("At the studio: cash");

    // A refund given by hand is on the receipt like any other.
    const [cash] = await world.db.select().from(payments);
    expect(await recordHandRefund(world.db, owner, cash.id, { amountCents: 1000, note: "Left early" }, NOW)).toEqual({ ok: true });
    expect((await getReceipt(world.db, JANE, made.ref))!.payments[0].refunds).toMatchObject([{ amountCents: 1000, pending: false, reason: "Left early" }]);
  });

  it("is not made for a booking a code paid for in full, an abandoned checkout, or a failed card", async () => {
    const [gift] = await world.db
      .insert((await import("@/db/schema")).promoCodes)
      .values({ code: "VS-FREE-HOUR", kind: "free_hour", value: 60, email: JANE, source: "manual", expiresAt: daysAfter(NOW, 30) })
      .returning();
    expectOk(await world.book({ durationMinutes: 60, promoCode: gift.code, paymentToken: undefined }));
    expect(await world.book({ date: FAR, paymentToken: "mock-card-declined" })).toMatchObject({ ok: false });
    expect(await loadReceipts(world.db, JANE)).toEqual({ receipts: [], unpaid: [] });
  });

  it("belongs to the customer whose email paid: nobody else can open it", async () => {
    const booked = expectOk(await world.book());
    expect(await getReceipt(world.db, "bob@example.com", booked.ref)).toBeNull();
    expect(await getReceipt(world.db, JANE, "VS-NOPE22")).toBeNull();
    expect(await getReceipt(world.db, JANE, "'; drop table payments; --")).toBeNull();
    expect(await receiptsOf("bob@example.com")).toEqual([]);
    expect(await getReceipt(world.db, " Jane@Example.com ", booked.ref)).not.toBeNull();
  });
});

describe("payments by year", () => {
  /** Two bookings paid in 2026; one of them refunded in part in 2027. */
  async function twoYears() {
    const first = expectOk(await world.book({ date: NEAR }));
    const second = expectOk(await world.book({ date: FAR, studioIds: [world.ids.paris], durationMinutes: 60 }));
    expectOk(await ownerRefund(world.db, second.ref, { amountCents: 1800, reason: "Goodwill" }, world.manageDeps()));
    // The refund was made in January 2027, on the studio's clock.
    await world.db.update(refunds).set({ createdAt: new Date("2027-01-04T15:00:00Z") });
    return { first, second };
  }

  it("counts a payment in the year it was made and a refund in the year it was made", async () => {
    const { first, second } = await twoYears();
    const receipts = await receiptsOf();
    expect(yearsOf(receipts)).toEqual([2027, 2026]);

    const in2026 = yearStatement(receipts, 2026);
    expect(in2026).toMatchObject({ year: 2026, paidCents: 17600 + 6800, refundedCents: 0, netCents: 24400 });
    expect(in2026.receipts.map((receipt) => receipt.ref).sort()).toEqual([first.ref, second.ref].sort());
    expect(in2026.transactions.map((transaction) => [transaction.kind, transaction.cents])).toEqual(
      expect.arrayContaining([
        ["payment", 17600],
        ["payment", 6800],
      ]),
    );

    const in2027 = yearStatement(receipts, 2027);
    expect(in2027).toMatchObject({ paidCents: 0, refundedCents: 1800, netCents: -1800 });
    expect(in2027.receipts.map((receipt) => receipt.ref)).toEqual([second.ref]);
    expect(in2027.transactions).toMatchObject([{ kind: "refund", cents: -1800, ref: second.ref, detail: "Goodwill", studios: "Studio Paris" }]);

    expect(yearStatement(receipts, 2025)).toMatchObject({ transactions: [], receipts: [], paidCents: 0, netCents: 0 });
  });

  it("draws the line at midnight on the studio's clock, not in London", async () => {
    expectOk(await world.book());
    // Paid on New Year's Eve at 10 pm in Winter Park, which is already January 1 in UTC.
    await world.db.update(payments).set({ createdAt: new Date("2027-01-01T03:00:00Z") });
    expect(yearsOf(await receiptsOf())).toEqual([2026]);
  });

  it("adds up to the payments themselves", async () => {
    await twoYears();
    const receipts = await receiptsOf();
    const all = transactionsOf(receipts);
    const [{ total }] = [{ total: (await world.db.select().from(payments)).reduce((sum, payment) => sum + payment.amountCents, 0) }];
    expect(all.filter((t) => t.kind === "payment").reduce((sum, t) => sum + t.cents, 0)).toBe(total);
    const refunded = (await world.db.select().from(refunds)).reduce((sum, refund) => sum + refund.amountCents, 0);
    expect(-all.filter((t) => t.kind === "refund").reduce((sum, t) => sum + t.cents, 0)).toBe(refunded);
    expect((await world.db.select().from(bookings)).length).toBe(2);
  });
});

describe("receipts as PDF files", () => {
  /** The studio's name and address at the top of a file: the published contact details. */
  const STUDIO = DEFAULT_FRAME.business;
  const pagesOf = async (file: Uint8Array) => (await PDFDocument.load(file)).getPageCount();

  it("makes one receipt a one-page PDF", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    expectOk(await ownerRefund(world.db, booked.ref, { amountCents: 2000, reason: "Lights failed" }, world.manageDeps()));
    const file = await receiptPdf((await getReceipt(world.db, JANE, booked.ref))!, STUDIO);
    expect(Buffer.from(file.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(await pagesOf(file)).toBe(1);
    expect((await PDFDocument.load(file)).getTitle()).toBe(`Receipt ${booked.ref}`);
  });

  it("makes a year one file: a summary page, then a page for each receipt", async () => {
    expectOk(await world.book({ date: NEAR }));
    expectOk(await world.book({ date: FAR, studioIds: [world.ids.paris], durationMinutes: 60 }));
    const statement = yearStatement(await receiptsOf(), 2026);
    const file = await yearPdf(statement, { name: "Jane Smith", email: JANE }, STUDIO);
    expect(await pagesOf(file)).toBe(3);
  });

  it("goes on to a second page when a year has more lines than one page holds", async () => {
    expectOk(await world.book({ date: NEAR }));
    const [receipt] = await receiptsOf();
    const many = Array.from({ length: 60 }, (_, index) => ({ ...receipt, ref: `VS-AAAA${String(index).padStart(2, "0")}` }));
    const statement = yearStatement(many, 2026);
    expect(statement.transactions).toHaveLength(60);
    expect(await pagesOf(await yearPdf({ ...statement, receipts: [] }, { name: "", email: JANE }, STUDIO))).toBeGreaterThan(1);
  });

  it("draws a name in any alphabet without failing", async () => {
    expectOk(await world.book({ customer: { name: "Zoë Łukasiewicz-Ñandú 李 Ольга “Bo” O’Neil", email: JANE, phone: "407-555-0100" } }));
    const [receipt] = await receiptsOf();
    await expect(receiptPdf(receipt, STUDIO)).resolves.toBeInstanceOf(Uint8Array);
    // The studio's own name is the owners' to type, so it is made safe for the file as well.
    await expect(receiptPdf(receipt, { ...STUDIO, name: "Студия 李 Visuals" })).resolves.toBeInstanceOf(Uint8Array);
    // Western European letters are kept, a letter with an unknown mark keeps its letter, and the rest is marked.
    expect(pdfSafe("Zoë Łukasiewicz-Ñandú 李 Ольга “Bo” O’Neil")).toBe("Zoë Lukasiewicz-Ñandú ? ????? “Bo” O’Neil");
    expect(pdfSafe("10:00 AM – 12:00 PM × 2\nnext\tline")).toBe("10:00 AM – 12:00 PM × 2 next line");
  });

  it("always writes the cents", () => {
    expect(money(17600)).toBe("$176.00");
    expect(money(-7410)).toBe("-$74.10");
    expect(money(5)).toBe("$0.05");
    expect(money(123456789)).toBe("$1,234,567.89");
    expect(money(0)).toBe("$0.00");
  });
});
