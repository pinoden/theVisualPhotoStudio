import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { BookingSummary } from "@/components/BookingSummary";
import { bookings } from "@/db/schema";
import { moveBooking } from "./appointments";
import type { AuthUser } from "./auth";
import { quoteSelection, toBookingViews } from "./bookings";
import { loadCatalog } from "./catalog";
import { editBooking } from "./edit-booking";
import { requestRescheduleCode } from "./manage";
import { issuePromo } from "./promos";
import { loadReceipts } from "./receipts";
import { saveSetting } from "./settings";
import { createTestWorld, daysAfter, expectOk, FAR, h, NOW, OWNER_EMAIL, type TestWorld } from "./testing";

/**
 * Sales tax (the owner's decision of 2026-11-20; question 84 in ProjectLibrary.md): added on top of the prices, a line
 * of its own, at the rate the owners set. Blanche for two hours is $176 on a weekday and $190 at the weekend: at 6.5%
 * that is $11.44 and $12.35 of tax.
 */
let world: TestWorld;
let owner: AuthUser;
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser(OWNER_EMAIL, "owner", "Olivia");
});

const SATURDAY = "2026-12-12";
const rowOf = async (ref: string) => (await world.db.select().from(bookings).where(eq(bookings.ref, ref)))[0];
const taxAt = (basisPoints: number) => saveSetting(world.db, "salesTaxBasisPoints", basisPoints);
const code = async (given: { kind: "percent" | "amount"; value: number }) =>
  (await issuePromo(world.db, { ...given, source: "manual", email: "jane@example.com", expiresAt: daysAfter(NOW, 60) }))!.code;

describe("with no rate set", () => {
  it("adds nothing, and shows no tax line", async () => {
    const { ref, totalCents } = expectOk(await world.book({ date: FAR }));
    expect(totalCents).toBe(17600);
    expect(await rowOf(ref)).toMatchObject({ taxCents: 0, taxBasisPoints: 0, taxStudio: false, taxAddons: false });
    const [view] = await toBookingViews(world.db, [await rowOf(ref)], NOW);
    expect(renderToStaticMarkup(createElement(BookingSummary, { booking: view }))).not.toContain("Sales tax");
    expect((await world.emails("booking_confirmation"))[0].body).not.toContain("sales tax");
  });
});

describe("with the owners' rate of 6.5%", () => {
  beforeEach(async () => {
    expect(await taxAt(650)).toBe(true);
  });

  it("adds the tax on top of the price, charges the card the total, and keeps the rule with the booking", async () => {
    const { ref, totalCents } = expectOk(await world.book({ date: FAR }));
    expect(totalCents).toBe(18744);
    expect(world.charges.map((charge) => charge.amountCents)).toEqual([18744]);
    expect(await rowOf(ref)).toMatchObject({ studiosSubtotalCents: 17600, taxCents: 1144, taxBasisPoints: 650, taxStudio: true, taxAddons: true, totalCents: 18744 });
  });

  it("shows it as a line of its own: on the booking, on the receipt and in the confirmation", async () => {
    const { ref } = expectOk(await world.book({ date: FAR }));
    const [view] = await toBookingViews(world.db, [await rowOf(ref)], NOW);
    expect(view).toMatchObject({ taxCents: 1144, taxBasisPoints: 650 });
    const summary = renderToStaticMarkup(createElement(BookingSummary, { booking: view }));
    expect(summary).toContain("<span>Sales tax (6.5%)</span><span>$11.44</span>");
    expect(summary).toContain("$187.44");
    const { receipts } = await loadReceipts(world.db, "jane@example.com");
    expect(receipts[0].lines).toEqual([
      { label: "Studio Blanche", cents: 17600 },
      { label: "Sales tax (6.5%)", cents: 1144 },
    ]);
    expect(receipts[0].totalCents).toBe(18744);
    // In the confirmation too, each on a line of its own (the owners' decision of 2026-11-27).
    expect((await world.emails("booking_confirmation"))[0].body).toContain("Studio Blanche: $176\nSales tax (6.5%): $11.44\nTotal: $187.44\n");
  });

  it("quotes the same total the booking takes, and refuses a total seen without the tax", async () => {
    const quoted = await quoteSelection(world.db, { studioIds: [world.ids.blanche], date: FAR, durationMinutes: 120, addons: [] }, NOW);
    expect(quoted).toMatchObject({ ok: true, quote: { taxCents: 1144, taxBasisPoints: 650, totalCents: 18744 } });
    expect(await world.book({ date: FAR, expectedTotalCents: 17600 })).toMatchObject({ ok: false, code: "price_changed", message: "The price is now $187.44. Please review and confirm again." });
    expect(world.charges).toEqual([]);
  });

  it("taxes the price after a discount code", async () => {
    const { ref, totalCents } = expectOk(await world.book({ date: FAR, promoCode: await code({ kind: "percent", value: 10 }) }));
    // $176 less 10% is $158.40; 6.5% of that is $10.296.
    expect(totalCents).toBe(16870);
    expect(await rowOf(ref)).toMatchObject({ promoDiscountCents: 1760, creditAppliedCents: 0, taxCents: 1030 });
    const { receipts } = await loadReceipts(world.db, "jane@example.com");
    expect(receipts[0].lines.map((line) => line.label)).toEqual(["Studio Blanche", "Discount code", "Sales tax (6.5%)"]);
  });

  it("lets studio credit pay the total, tax included: the credit's line comes after the tax", async () => {
    const credit = await code({ kind: "amount", value: 10000 });
    const { ref, totalCents } = expectOk(await world.book({ date: FAR, promoCode: credit }));
    expect(totalCents).toBe(8744);
    expect(await rowOf(ref)).toMatchObject({ promoDiscountCents: 10000, creditAppliedCents: 10000, taxCents: 1144, totalCents: 8744 });
    const { receipts } = await loadReceipts(world.db, "jane@example.com");
    expect(receipts[0].lines.map((line) => [line.label, line.cents])).toEqual([
      ["Studio Blanche", 17600],
      ["Sales tax (6.5%)", 1144],
      ["Paid with studio credit", -10000],
    ]);
    // Credit worth more than the booking pays all of it, and no card is asked.
    const all = expectOk(await world.book({ date: SATURDAY, promoCode: await code({ kind: "amount", value: 50000 }), paymentToken: undefined }));
    expect(all.totalCents).toBe(0);
    expect(await rowOf(all.ref)).toMatchObject({ creditAppliedCents: 20235, taxCents: 1235, totalCents: 0 });
  });

  it("leaves out what the owners do not tax", async () => {
    // Any add-on Blanche takes: an extra guest, in the starting catalog.
    const addon = (await loadCatalog(world.db)).addons.find((entry) => entry.studioId === null || entry.studioId === world.ids.blanche);
    if (!addon) throw new Error("the starting catalog has no add-on for Blanche");
    await saveSetting(world.db, "taxAddons", false);
    const untaxedAddon = expectOk(await world.book({ date: FAR, addons: [{ addonId: addon.id, quantity: 1 }] }));
    expect(await rowOf(untaxedAddon.ref)).toMatchObject({ addonsCents: addon.priceCents, taxCents: 1144, taxStudio: true, taxAddons: false, totalCents: 17600 + addon.priceCents + 1144 });
    await saveSetting(world.db, "taxAddons", true);
    await saveSetting(world.db, "taxStudioTime", false);
    const untaxedTime = expectOk(await world.book({ date: SATURDAY, addons: [{ addonId: addon.id, quantity: 1 }] }));
    const addonTax = Math.round((addon.priceCents * 650) / 10_000);
    expect(await rowOf(untaxedTime.ref)).toMatchObject({ taxCents: addonTax, taxStudio: false, taxAddons: true, totalCents: 19000 + addon.priceCents + addonTax });
  });

  it("makes a reschedule code worth the booking with its tax, a discount's share of it included", async () => {
    const booked = expectOk(await world.book({ date: FAR, promoCode: await code({ kind: "percent", value: 10 }) }));
    const released = expectOk(await requestRescheduleCode(world.db, booked.ref, { kind: "token", token: booked.manageToken }, world.manageDeps()));
    // $168.70 paid, the $17.60 the code took off, and the $1.14 of tax that saved: the same booking again costs nothing.
    expect(released.valueCents).toBe(18744);
    const again = expectOk(await world.book({ date: "2026-12-10", promoCode: released.code, paymentToken: undefined }));
    expect(again.totalCents).toBe(0);
    expect(await rowOf(again.ref)).toMatchObject({ taxCents: 1144, creditAppliedCents: 18744 });
  });

  it("prices a moved booking by the rate it was made at, whatever the rate is now", async () => {
    const { ref } = expectOk(await world.book({ date: FAR }));
    await taxAt(0);
    expectOk(await moveBooking(world.db, owner, ref, { date: SATURDAY, startMinute: h(10), countsAsClientMove: false }, NOW));
    expect(await rowOf(ref)).toMatchObject({ studiosSubtotalCents: 19000, taxCents: 1235, taxBasisPoints: 650, totalCents: 20235 });
    expect((await world.emails("booking_moved")).at(-1)!.body).toContain("so its total is now $202.35 instead of $187.44.\nStill to pay: $14.91");
  });

  it("prices a changed booking by the rate it was made at", async () => {
    const { ref } = expectOk(await world.book({ date: FAR }));
    await taxAt(1000);
    expect(await editBooking(world.db, owner, ref, { studioIds: [world.ids.blanche], durationMinutes: 60, addons: [] }, NOW)).toMatchObject({ ok: true });
    const row = await rowOf(ref);
    expect(row).toMatchObject({ taxBasisPoints: 650, taxCents: Math.round((row.studiosSubtotalCents * 650) / 10_000) });
    expect(row.totalCents).toBe(row.studiosSubtotalCents + row.taxCents);
  });
});

describe("a booking made before the tax", () => {
  it("stays without it when it is moved or changed after the owners set a rate", async () => {
    const { ref } = expectOk(await world.book({ date: FAR }));
    await taxAt(650);
    expectOk(await moveBooking(world.db, owner, ref, { date: SATURDAY, startMinute: h(10), countsAsClientMove: false }, NOW));
    expect(await rowOf(ref)).toMatchObject({ taxCents: 0, taxBasisPoints: 0, totalCents: 19000 });
    expect(await editBooking(world.db, owner, ref, { studioIds: [world.ids.blanche], durationMinutes: 60, addons: [] }, NOW)).toMatchObject({ ok: true });
    const row = await rowOf(ref);
    expect(row).toMatchObject({ taxCents: 0, totalCents: row.studiosSubtotalCents });
  });
});

describe("the setting", () => {
  it("takes a rate from 0 to 20%, in hundredths of a percent, and nothing else", async () => {
    for (const good of [0, 1, 650, 675, 2000]) expect(await taxAt(good)).toBe(true);
    for (const bad of [-1, 6.5, 2001, Number.NaN]) expect(await taxAt(bad)).toBe(false);
    expect((await loadCatalog(world.db)).settings).toMatchObject({ salesTaxBasisPoints: 2000, taxStudioTime: true, taxSessions: true, taxAddons: true });
  });
});
