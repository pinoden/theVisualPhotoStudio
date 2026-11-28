import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bookings, studioHolds } from "@/db/schema";
import { findPrice } from "@/lib/domain/pricing";
import { salePriceCents } from "@/lib/domain/sale";
import { moveBooking } from "./appointments";
import type { AuthUser } from "./auth";
import { quoteSelection, toBookingViews } from "./bookings";
import { loadCatalog, salesAround } from "./catalog";
import { requestRescheduleCode } from "./manage";
import { deleteSale, endSale, listSales, saveSale, type SaleInput } from "./sales";
import { createTestWorld, daysAfter, expectOk, FAR, h, NEAR, NOW, OWNER_EMAIL, type TestWorld } from "./testing";

/** NOW, on the studio's clock. */
const TODAY = "2026-11-14";
/** FAR is a Wednesday; the Saturday after it. */
const SATURDAY = "2026-12-12";

describe("a sale the owners set (the owner, 2026-11-27; question 87)", () => {
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

  const blackFriday = (overrides: Partial<SaleInput> = {}): SaleInput => ({
    name: "Black Friday",
    percent: "25",
    studioIds: [],
    bookFrom: TODAY,
    bookUntil: "2026-11-15",
    visitFrom: "",
    visitUntil: "",
    ...overrides,
  });
  const rowOf = async (ref: string) => (await world.db.select().from(bookings).where(eq(bookings.ref, ref)))[0];
  const holdPrices = async (ref: string) =>
    (await world.db.select({ priceCents: studioHolds.priceCents }).from(studioHolds).innerJoin(bookings, eq(bookings.id, studioHolds.bookingId)).where(eq(bookings.ref, ref))).map(
      (hold) => hold.priceCents,
    );
  const usualPrice = async (slug: string, dayType: "weekday" | "weekend") => findPrice(world.ids[slug], dayType, 120, (await loadCatalog(world.db)).rules)!;

  it("is saved only with a name, a whole percentage and days that follow each other", async () => {
    const refusal = async (overrides: Partial<SaleInput>) => {
      const result = await saveSale(world.db, null, blackFriday(overrides));
      return result.ok ? null : result.message;
    };
    const percent = "Enter what comes off as a whole percentage from 1 to 90.";
    expect(await refusal({ name: " " })).toBe("Give the sale a name of 2 to 60 characters: clients read it.");
    expect(await refusal({ percent: "0" })).toBe(percent);
    expect(await refusal({ percent: "12.5" })).toBe(percent);
    expect(await refusal({ percent: "95" })).toBe(percent);
    expect(await refusal({ bookFrom: "soon" })).toBe("Choose the first and the last day the sale can be booked.");
    expect(await refusal({ bookUntil: "2026-11-13" })).toBe("The last day of the sale must be on or after its first.");
    expect(await refusal({ visitFrom: "2026-12-10", visitUntil: "2026-12-01" })).toBe("The last day of studio time must be on or after the first.");
    expect(await refusal({ visitUntil: "2026-11-10" })).toBe("The studio time would be over before the sale begins.");
    expect(await refusal({ studioIds: ["00000000-0000-4000-8000-000000000000"] })).toBe("Unknown studio.");
    expect(await listSales(world.db)).toEqual([]);

    const saved = expectOk(await saveSale(world.db, null, blackFriday({ name: "  Black   Friday ", studioIds: [world.ids.blanche] })));
    expect(await listSales(world.db)).toEqual([
      { id: saved.id, name: "Black Friday", percent: 25, studioIds: [world.ids.blanche], bookFrom: TODAY, bookUntil: "2026-11-15", visitFrom: null, visitUntil: null },
    ]);
    // Changed in place.
    expectOk(await saveSale(world.db, saved.id, blackFriday({ percent: "30" })));
    expect((await listSales(world.db))[0]).toMatchObject({ id: saved.id, percent: 30, studioIds: [] });
    expect(await saveSale(world.db, "00000000-0000-4000-8000-000000000000", blackFriday())).toEqual({ ok: false, message: "That sale was deleted meanwhile." });
  });

  it("charges a booking made on its days the sale's price, and the booking keeps what it was sold at", async () => {
    expectOk(await saveSale(world.db, null, blackFriday()));
    // Blanche for two hours on a weekday: $176, and $132 with a quarter off. The booking screen is quoted the same.
    const quoted = expectOk(await quoteSelection(world.db, { studioIds: [world.ids.blanche], date: NEAR, durationMinutes: 120 }, NOW));
    expect(quoted.quote).toMatchObject({ totalCents: 13200, saleCents: 4400, usualStudioLines: [{ studioId: world.ids.blanche, priceCents: 17600 }] });
    // A total from before the sale is refused with the price as it is now.
    expect(await world.book({ expectedTotalCents: 17600 })).toMatchObject({ ok: false, code: "price_changed", message: "The price is now $132. Please review and confirm again." });
    const booked = expectOk(await world.book({ expectedTotalCents: 13200 }));
    const row = await rowOf(booked.ref);
    expect(row).toMatchObject({ studiosSubtotalCents: 13200, totalCents: 13200, saleCents: 4400, sale: { name: "Black Friday", percents: { [world.ids.blanche]: 25 } } });
    expect(await holdPrices(booked.ref)).toEqual([13200]);
    expect((await toBookingViews(world.db, [row], NOW))[0]).toMatchObject({ saleName: "Black Friday", saleCents: 4400, totalCents: 13200 });

    // Two days on, the sale is over: the usual price, and nothing kept of a sale.
    const later = expectOk(await world.book({ startMinute: h(14) }, { now: daysAfter(NOW, 2) }));
    expect(await rowOf(later.ref)).toMatchObject({ totalCents: 17600, saleCents: 0, sale: null });
    expect((await toBookingViews(world.db, [await rowOf(later.ref)], NOW))[0]).toMatchObject({ saleName: null, saleCents: 0 });
  });

  it("is for its studios only, and for studio time on its days only when the owners limit them", async () => {
    expectOk(await saveSale(world.db, null, blackFriday({ studioIds: [world.ids.paris], visitFrom: NEAR, visitUntil: NEAR })));
    const paris = await usualPrice("paris", "weekday");
    // Blanche is not on sale.
    expect(await rowOf(expectOk(await world.book()).ref)).toMatchObject({ totalCents: 17600, saleCents: 0, sale: null });
    // Paris is, on that day,
    const onTheDay = expectOk(await world.book({ studioIds: [world.ids.paris] }));
    expect(await rowOf(onTheDay.ref)).toMatchObject({ totalCents: salePriceCents(paris, 25), saleCents: paris - salePriceCents(paris, 25) });
    // and not on another.
    const anotherDay = expectOk(await world.book({ studioIds: [world.ids.paris], date: FAR }));
    expect(await rowOf(anotherDay.ref)).toMatchObject({ totalCents: paris, saleCents: 0, sale: null });
  });

  it("stays with a booking the studio moves to a day of the other kind, whatever became of the sale", async () => {
    const sale = expectOk(await saveSale(world.db, null, blackFriday()));
    const booked = expectOk(await world.book({ date: FAR }));
    expect(await rowOf(booked.ref)).toMatchObject({ totalCents: 13200, pricedAs: "weekday" });
    expect(await deleteSale(world.db, sale.id)).toBe(true);
    expectOk(await moveBooking(world.db, owner, booked.ref, { date: SATURDAY, startMinute: h(10), countsAsClientMove: false }, NOW));
    const weekend = await usualPrice("blanche", "weekend");
    expect(weekend).toBeGreaterThan(17600);
    expect(await rowOf(booked.ref)).toMatchObject({ pricedAs: "weekend", totalCents: salePriceCents(weekend, 25), saleCents: weekend - salePriceCents(weekend, 25) });
    expect(await holdPrices(booked.ref)).toEqual([salePriceCents(weekend, 25)]);
  });

  it("gives a booking released for a reschedule code a code worth the studio time it stood for", async () => {
    expectOk(await saveSale(world.db, null, blackFriday()));
    const booked = expectOk(await world.book());
    const released = expectOk(await requestRescheduleCode(world.db, booked.ref, { kind: "token", token: booked.manageToken }, world.manageDeps()));
    // The $132 paid and the $44 the sale took off: the same two hours at a new time, after the sale, cost nothing more.
    expect(released.valueCents).toBe(17600);
    const mail = (await world.emails("reschedule_code")).at(-1)!;
    expect(mail.body).toContain("What you paid, plus the $44 the sale price took off, is now a credit of $176.");
  });

  it("is ended by the owners when they say so, and a page is told only of the sales near its day", async () => {
    const on = expectOk(await saveSale(world.db, null, blackFriday()));
    const later = expectOk(await saveSale(world.db, null, blackFriday({ name: "Christmas", bookFrom: "2026-12-20", bookUntil: "2026-12-24" })));
    const catalog = await loadCatalog(world.db);
    // The one that ends last first.
    expect(catalog.sales.map((sale) => sale.name)).toEqual(["Christmas", "Black Friday"]);
    expect(salesAround(catalog, TODAY).sales.map((sale) => sale.name)).toEqual(["Black Friday"]);
    expect(salesAround(catalog, "2026-11-16").sales.map((sale) => sale.name)).toEqual(["Black Friday"]); // the day after its last
    expect(salesAround(catalog, "2026-11-17").sales).toEqual([]);
    expect(salesAround(catalog, "2026-12-19").sales.map((sale) => sale.name)).toEqual(["Christmas"]); // the day before its first
    expect(salesAround(catalog, "2026-12-18").sales).toEqual([]);

    // Ended on its second day: its first day stays its last. One that has not begun is deleted.
    expect(await endSale(world.db, on.id, "2026-11-15")).toBe(true);
    expect((await listSales(world.db)).find((sale) => sale.id === on.id)).toMatchObject({ bookFrom: TODAY, bookUntil: TODAY });
    expect(await endSale(world.db, later.id, "2026-11-15")).toBe(true);
    expect((await listSales(world.db)).map((sale) => sale.id)).toEqual([on.id]);
    // Ended already: left as it is.
    expect(await endSale(world.db, on.id, "2026-11-16")).toBe(true);
    expect((await listSales(world.db))[0]).toMatchObject({ bookUntil: TODAY });
    expect(await deleteSale(world.db, on.id)).toBe(true);
    expect(await endSale(world.db, on.id, "2026-11-16")).toBe(false);
  });
});
