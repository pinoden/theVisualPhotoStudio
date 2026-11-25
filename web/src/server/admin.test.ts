import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bundleTables } from "@/lib/catalog-view";
import { combinedStarts } from "@/lib/domain/availability";
import { bookableDurations } from "@/lib/domain/pricing";
import { bundlePrices, priceRules, sessions, staffShifts, users } from "@/db/schema";
import {
  addStaff,
  countUpcoming,
  createManualCode,
  listBookings,
  listCodes,
  listRefundProblems,
  listStaff,
  removeStaff,
  saveBundlePrice,
  savePrice,
  saveStudioHours,
  setShift,
  setSpecialDate,
  setStaffLevel,
  voidCode,
} from "./admin";
import { createBlocks, listBlockSeries, removeBlocks } from "./blocked-time";
import { getSessionUser, requestLoginCode, verifyLoginCode } from "./auth";
import { loadDayAvailability } from "./availability";
import { loadCatalog } from "./catalog";
import { cancelBooking, ownerRefund } from "./manage";
import { loadSettings, saveSetting } from "./settings";
import { getDaySheet } from "./staff";
import { createTestWorld, expectOk, FAR, h, NEAR, NOW, type TestWorld } from "./testing";

let world: TestWorld;
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(() => world.reset());

const SAT = "2026-11-21";
const MON = "2026-11-16";

async function freeStarts(studio: string, date: string, durationMinutes = 60) {
  const catalog = await loadCatalog(world.db);
  const day = await loadDayAvailability(world.db, catalog, date, NOW);
  return combinedStarts(
    day.days.filter((d) => d.studioId === world.ids[studio]),
    { durationMinutes, incrementMinutes: 60, earliestStartMinute: day.earliestStartMinute },
  );
}

describe("staff and shifts", () => {
  it("gives an address staff access, assigns days, and shows the roster", async () => {
    const added = expectOk(await addStaff(world.db, " Sam@Studio.test ", "Sam"));
    expect(await setShift(world.db, added.id, NEAR, true)).toBe(true);
    expect(await setShift(world.db, added.id, NEAR, true)).toBe(true); // assigning twice is harmless
    expect(await setShift(world.db, added.id, "2026-11-25", true)).toBe(true);
    expect(await setShift(world.db, added.id, "2026-11-01", true)).toBe(true); // already past
    expect(await listStaff(world.db, "2026-11-14")).toEqual([
      { id: added.id, email: "sam@studio.test", name: "Sam", level: "staff", days: [NEAR, "2026-11-25"] },
    ]);

    expect(await setShift(world.db, added.id, NEAR, false)).toBe(true);
    expect((await listStaff(world.db, "2026-11-14"))[0].days).toEqual(["2026-11-25"]);
  });

  it("adds a Studio Manager, lists managers first, and changes a person's level without signing them out", async () => {
    const sam = expectOk(await addStaff(world.db, "sam@studio.test", "Sam"));
    const mia = expectOk(await addStaff(world.db, "mia@studio.test", "Mia", "manager"));
    expect((await listStaff(world.db, "2026-11-14")).map((person) => [person.email, person.level])).toEqual([
      ["mia@studio.test", "manager"],
      ["sam@studio.test", "staff"],
    ]);
    // A manager sees every day, so none can be assigned to one.
    expect(await setShift(world.db, mia.id, NEAR, true)).toBe(false);

    // Sam is signed in as an attendant when the owners make him a manager: his next request is a manager's.
    expectOk(await requestLoginCode(world.db, "sam@studio.test", NOW));
    const code = /code: (\d{6})/.exec((await world.emails("login_code")).at(-1)!.subject)![1];
    const signedIn = expectOk(await verifyLoginCode(world.db, "sam@studio.test", code, { now: NOW, ownerEmails: [] }));
    expect(signedIn.user.role).toBe("staff");
    expect(await setShift(world.db, sam.id, NEAR, true)).toBe(true);
    expect(await setStaffLevel(world.db, sam.id, "manager")).toBe(true);
    expect((await getSessionUser(world.db, signedIn.sessionToken, NOW, []))?.role).toBe("manager");
    // Back to attendant: the day assigned before is still his.
    expect(await setStaffLevel(world.db, sam.id, "staff")).toBe(true);
    expect((await listStaff(world.db, "2026-11-14")).find((person) => person.id === sam.id)).toMatchObject({ level: "staff", days: [NEAR] });

    // Only an attendant or a manager has a level, and only those two levels exist.
    const customer = await world.addUser("jane@example.com", "customer");
    expect(await setStaffLevel(world.db, customer.id, "manager")).toBe(false);
    expect(await setStaffLevel(world.db, sam.id, "owner")).toBe(false);
    expect(await setStaffLevel(world.db, "not-an-id", "manager")).toBe(false);
    expect(await addStaff(world.db, "eve@studio.test", "Eve", "owner" as never)).toEqual({ ok: false, message: "Choose Studio Manager or Studio Attendant." });

    // Removing access works for a manager as for an attendant, and signs them out.
    await removeStaff(world.db, mia.id);
    expect((await world.db.select().from(users).where(eq(users.id, mia.id)))[0].role).toBe("customer");
    expect((await listStaff(world.db, "2026-11-14")).map((person) => person.email)).toEqual(["sam@studio.test"]);
  });

  it("turns an existing customer into staff but never touches an owner", async () => {
    const customer = await world.addUser("jane@example.com", "customer", "Jane");
    expect(expectOk(await addStaff(world.db, "jane@example.com", "")).id).toBe(customer.id);
    expect((await world.db.select().from(users).where(eq(users.id, customer.id)))[0]).toMatchObject({ role: "staff", name: "Jane" });

    await world.addUser("owner@studio.test", "owner");
    expect(await addStaff(world.db, "owner@studio.test", "")).toEqual({ ok: false, message: "That address belongs to an owner." });
    expect(await addStaff(world.db, "not-an-email", "")).toEqual({ ok: false, message: "Enter a valid email address." });
  });

  it("only assigns days to staff, and only real dates", async () => {
    const customer = await world.addUser("jane@example.com", "customer");
    const staff = expectOk(await addStaff(world.db, "sam@studio.test", "Sam"));
    expect(await setShift(world.db, customer.id, NEAR, true)).toBe(false);
    expect(await setShift(world.db, staff.id, "2026-02-30", true)).toBe(false);
    expect(await setShift(world.db, "3f2c1e9a-6b7d-4c8e-9f10-112233445566", NEAR, true)).toBe(false);
    expect(await world.db.select().from(staffShifts)).toHaveLength(0);
  });

  it("removes access at once: the open session, the shifts and the day sheet", async () => {
    const staff = expectOk(await addStaff(world.db, "sam@studio.test", "Sam"));
    await setShift(world.db, staff.id, NEAR, true);
    await requestLoginCode(world.db, "sam@studio.test", NOW);
    const code = /code: (\d{6})/.exec((await world.emails("login_code"))[0].subject)![1];
    const session = expectOk(await verifyLoginCode(world.db, "sam@studio.test", code, { now: NOW, ownerEmails: [] }));
    expect(expectOk(await getDaySheet(world.db, session.user, NEAR)).entries).toEqual([]);

    await removeStaff(world.db, staff.id);
    expect(await getSessionUser(world.db, session.sessionToken, NOW)).toBeNull();
    expect(await world.db.select().from(sessions)).toHaveLength(0);
    expect(await world.db.select().from(staffShifts)).toHaveLength(0);
    expect(await listStaff(world.db, "2026-11-14")).toEqual([]);
    // Even with a stale copy of the user object, the day is no longer theirs.
    expect(await getDaySheet(world.db, session.user, NEAR)).toEqual({ ok: false, reason: "forbidden" });
  });
});

describe("prices", () => {
  it("charges a new weekend price on Saturday and leaves weekdays alone", async () => {
    expect(await savePrice(world.db, { studioId: world.ids.blanche, dayType: "weekend", durationMinutes: 60, priceCents: 11000 })).toBe(true);
    expect(expectOk(await world.book({ date: SAT, durationMinutes: 60 })).totalCents).toBe(11000);
    expect(expectOk(await world.book({ date: NEAR, durationMinutes: 60 })).totalCents).toBe(8800);
  });

  it("adds a duration that did not exist, and removes one so it can no longer be booked", async () => {
    // Six hours of Paris is priced on from its longest listed length until the owners type a price: $300 for five, $55 more an hour.
    expect(expectOk(await world.book({ studioIds: [world.ids.paris], durationMinutes: 360 })).totalCents).toBe(35500);
    expect(await savePrice(world.db, { studioId: world.ids.paris, dayType: "weekday", durationMinutes: 360, priceCents: 34000 })).toBe(true);
    expect(expectOk(await world.book({ studioIds: [world.ids.paris], durationMinutes: 360, date: FAR, startMinute: h(9) })).totalCents).toBe(34000);

    expect(await savePrice(world.db, { studioId: world.ids.blanche, dayType: "weekday", durationMinutes: 60, priceCents: null })).toBe(true);
    expect(await world.book({ durationMinutes: 60, startMinute: h(16) })).toMatchObject({ ok: false, code: "invalid_price" });
  });

  it("gives a bundle a price for a new length, changes one and takes one off its list (question 81)", async () => {
    const pair = [world.ids.paris, world.ids.dayglow];
    const listOf = async () => bundleTables(await loadCatalog(world.db)).find((table) => table.studioIds.length === 2 && pair.every((id) => table.studioIds.includes(id)))?.prices.map((row) => [row.durationMinutes, row.priceCents]);
    // The owner's prices, from the seed.
    expect(await listOf()).toEqual([[60, 11500], [90, 17200], [120, 23000], [180, 32000], [240, 40000], [300, 49000]]);
    // Six hours of the two goes on rising as from four hours to five, $90 an hour, until it has a price of its own.
    expect(expectOk(await world.book({ studioIds: pair, durationMinutes: 360 })).totalCents).toBe(58000);
    expect(await saveBundlePrice(world.db, { studioIds: pair, durationMinutes: 360, priceCents: 56000 })).toBe(true);
    expect(expectOk(await world.book({ studioIds: pair, durationMinutes: 360, date: FAR, startMinute: h(9) })).totalCents).toBe(56000);
    expect(await saveBundlePrice(world.db, { studioIds: pair, durationMinutes: 360, priceCents: 58000 })).toBe(true);
    expect(expectOk(await world.book({ studioIds: [...pair].reverse(), durationMinutes: 330, date: "2026-12-16", startMinute: h(9) })).totalCents).toBe(53500); // between $490 and $580

    expect(await saveBundlePrice(world.db, { studioIds: [...pair].reverse(), durationMinutes: 60, priceCents: 12000 })).toBe(true); // the same bundle, however its studios are named
    expect(await saveBundlePrice(world.db, { studioIds: pair, durationMinutes: 90, priceCents: null })).toBe(true);
    expect(await listOf()).toEqual([[60, 12000], [120, 23000], [180, 32000], [240, 40000], [300, 49000], [360, 58000]]);
    expect(await world.db.select().from(bundlePrices)).toHaveLength(20);
  });

  it("offers every studio and bundle from 1 to 10 hours, as the owners set: every half hour, every hour, or the listed lengths", async () => {
    const lengths = async (studioIds: string[]) => bookableDurations(studioIds, "weekday", (await loadCatalog(world.db)).rules, (await loadCatalog(world.db)).bundlePrices);
    const all = [world.ids.blanche, world.ids.dayglow, world.ids.paris];
    const halfHours = Array.from({ length: 19 }, (_, i) => 60 + i * 30);
    // The owner, 2026-11-25: "Times options should be the same for every studio 1-10 hours".
    for (const studioIds of [[world.ids.paris], [world.ids.dayglow], [world.ids.blanche], [world.ids.paris, world.ids.dayglow], [world.ids.blanche, world.ids.paris], all]) {
      expect(await lengths(studioIds)).toEqual(halfHours);
    }
    expect(await saveSetting(world.db, "betweenLengthsMinutes", 60)).toBe(true);
    expect(await lengths([world.ids.paris])).toEqual([60, 90, 120, 180, 240, 300, 360, 420, 480, 540, 600]);
    expect(await lengths(all)).toEqual([60, 120, 180, 240, 300, 360, 420, 480, 540, 600]);
    expect(await saveSetting(world.db, "longestBookingMinutes", 480)).toBe(true);
    expect(await lengths([world.ids.paris])).toEqual([60, 90, 120, 180, 240, 300, 360, 420, 480]);
    expect((await lengths(all)).at(-1)).toBe(600); // a listed length is always sold
    expect(await saveSetting(world.db, "betweenLengthsMinutes", 0)).toBe(true);
    expect(await lengths(all)).toEqual([60, 120, 180, 240, 300, 600]);
    expect(await lengths([world.ids.paris])).toEqual([60, 90, 120, 180, 240, 300]);
    expect(await saveSetting(world.db, "betweenLengthsMinutes", 45)).toBe(false);
    expect(await saveSetting(world.db, "longestBookingMinutes", 450)).toBe(false);
    // The lengths shown before "More": a list of different lengths, in quarters of an hour.
    expect((await loadSettings(world.db)).shownLengthsMinutes).toEqual([60, 120, 180, 240, 360]);
    expect(await saveSetting(world.db, "shownLengthsMinutes", [60, 90, 120])).toBe(true);
    for (const wrong of [[], [60, 60], [50], [0], [1500], "60", Array.from({ length: 9 }, (_, i) => (i + 1) * 60)]) {
      expect(await saveSetting(world.db, "shownLengthsMinutes", wrong)).toBe(false);
    }
    expect((await loadSettings(world.db)).shownLengthsMinutes).toEqual([60, 90, 120]);
    expect(await loadSettings(world.db)).toMatchObject({ betweenLengthsMinutes: 0, longestBookingMinutes: 480 });
  });

  it("refuses a bundle's price that makes no sense", async () => {
    const before = await world.db.select().from(bundlePrices);
    const pair = [world.ids.paris, world.ids.dayglow];
    expect(await saveBundlePrice(world.db, { studioIds: [world.ids.paris], durationMinutes: 60, priceCents: 5000 })).toBe(false);
    expect(await saveBundlePrice(world.db, { studioIds: [world.ids.paris, world.ids.paris], durationMinutes: 60, priceCents: 5000 })).toBe(false);
    expect(await saveBundlePrice(world.db, { studioIds: [world.ids.paris, "3f2c1e9a-6b7d-4c8e-9f10-112233445566"], durationMinutes: 60, priceCents: 5000 })).toBe(false);
    expect(await saveBundlePrice(world.db, { studioIds: [world.ids.paris, "x' or '1'='1"], durationMinutes: 60, priceCents: 5000 })).toBe(false);
    expect(await saveBundlePrice(world.db, { studioIds: pair, durationMinutes: 50, priceCents: 5000 })).toBe(false);
    expect(await saveBundlePrice(world.db, { studioIds: pair, durationMinutes: 60, priceCents: -1 })).toBe(false);
    expect(await saveBundlePrice(world.db, { studioIds: pair, durationMinutes: 60, priceCents: 115.5 })).toBe(false);
    expect(await world.db.select().from(bundlePrices)).toEqual(before);
  });

  it("refuses prices that make no sense", async () => {
    const base = { studioId: world.ids.blanche, dayType: "weekday" as const, durationMinutes: 60 };
    const before = await world.db.select().from(priceRules);
    expect(await savePrice(world.db, { ...base, priceCents: -100 })).toBe(false);
    expect(await savePrice(world.db, { ...base, priceCents: 88.5 })).toBe(false);
    expect(await savePrice(world.db, { ...base, durationMinutes: 50, priceCents: 5000 })).toBe(false);
    expect(await savePrice(world.db, { ...base, durationMinutes: 0, priceCents: 5000 })).toBe(false);
    expect(await savePrice(world.db, { ...base, dayType: "holiday" as "weekday", priceCents: 5000 })).toBe(false);
    expect(await savePrice(world.db, { ...base, studioId: "3f2c1e9a-6b7d-4c8e-9f10-112233445566", priceCents: 5000 })).toBe(false);
    expect(await world.db.select().from(priceRules)).toEqual(before);
  });

  it("prices a holiday as a weekend day, and back", async () => {
    await savePrice(world.db, { studioId: world.ids.blanche, dayType: "weekend", durationMinutes: 60, priceCents: 11000 });
    expect(await setSpecialDate(world.db, NEAR, "weekend", "Holiday")).toBe(true);
    expect(expectOk(await world.book({ durationMinutes: 60 })).totalCents).toBe(11000);
    expect(await setSpecialDate(world.db, NEAR, null)).toBe(true);
    expect(expectOk(await world.book({ durationMinutes: 60, startMinute: h(14) })).totalCents).toBe(8800);
    expect(await setSpecialDate(world.db, "not-a-date", "weekend")).toBe(false);
  });
});

describe("opening hours", () => {
  it("closes a day, reopens it with new hours, and refuses impossible hours", async () => {
    expect((await freeStarts("blanche", MON))[0]).toBe(h(9)); // open from 9:00 on weekdays
    expect(await saveStudioHours(world.db, world.ids.blanche, 1, null)).toBe(true);
    expect(await freeStarts("blanche", MON)).toEqual([]);
    expect((await freeStarts("paris", MON)).length).toBeGreaterThan(0);

    expect(await saveStudioHours(world.db, world.ids.blanche, 1, { openMinute: h(12), closeMinute: h(15) })).toBe(true);
    expect(await freeStarts("blanche", MON)).toEqual([h(12), h(13), h(14)]);

    expect(await saveStudioHours(world.db, world.ids.blanche, 1, { openMinute: h(15), closeMinute: h(12) })).toBe(false);
    expect(await saveStudioHours(world.db, world.ids.blanche, 8, { openMinute: h(9), closeMinute: h(17) })).toBe(false);
    expect(await saveStudioHours(world.db, world.ids.blanche, 1, { openMinute: h(9), closeMinute: h(25) })).toBe(false);
  });
});

describe("blocking time", () => {
  // One day, part of it, as the Hours page made it before Availability & Blocked Time (src/server/blocked-time.ts).
  const oneDay = (studioIds: string[], startMinute: number, endMinute: number, note = "") =>
    createBlocks(world.db, { studioIds, from: NEAR, to: NEAR, wholeDay: false, startMinute, endMinute, weekdays: [], reason: "", note }, NOW);

  it("takes studios off the calendar for a span and gives the time back when removed", async () => {
    const block = await oneDay([world.ids.blanche, world.ids.paris], h(12), h(14), "Repainting");
    expect(block.ok).toBe(true);
    const starts = await freeStarts("blanche", NEAR);
    expect(starts).not.toContain(h(12));
    expect(starts).not.toContain(h(13));
    expect(starts).not.toContain(h(11)); // an 11:00 booking could not be cleaned up before the block
    expect(starts).toContain(h(14));
    expect(await freeStarts("dayglow", NEAR)).toContain(h(12));
    expect(await world.book({ startMinute: h(12), durationMinutes: 60 })).toMatchObject({ ok: false, code: "slot_taken" });

    const [series] = await listBlockSeries(world.db, NOW);
    expect(series).toMatchObject({ note: "Repainting", studios: ["Studio Blanche", "Studio Paris"], days: [{ date: NEAR, startMinute: h(12), endMinute: h(14) }] });

    await removeBlocks(world.db, series.key);
    expect(await freeStarts("blanche", NEAR)).toContain(h(12));
    expect(await listBlockSeries(world.db, NOW)).toEqual([]);
  });

  it("is refused where a booking already is, leaving nothing half-blocked", async () => {
    expectOk(await world.book({ studioIds: [world.ids.paris], startMinute: h(13), durationMinutes: 60 }));
    const result = await oneDay([world.ids.blanche, world.ids.paris], h(12), h(14));
    expect(result.ok).toBe(false);
    expect(await listBlockSeries(world.db, NOW)).toEqual([]);
    expect(await freeStarts("blanche", NEAR)).toContain(h(12)); // Blanche was not blocked either
  });

  it("validates its input", async () => {
    expect((await oneDay([], h(12), h(14))).ok).toBe(false);
    expect((await createBlocks(world.db, { studioIds: [world.ids.blanche], from: "2026-02-30", to: "", wholeDay: true, startMinute: 0, endMinute: 0, weekdays: [], reason: "", note: "" }, NOW)).ok).toBe(false);
    expect((await oneDay([world.ids.blanche], h(14), h(12))).ok).toBe(false);
    expect((await oneDay(["3f2c1e9a-6b7d-4c8e-9f10-112233445566"], h(12), h(14))).ok).toBe(false);
    expect((await oneDay([world.ids.blanche], 0, 1440)).ok).toBe(true); // a whole day
    expect(await freeStarts("blanche", NEAR)).toEqual([]);
  });
});

describe("the bookings list", () => {
  it("shows bookings in a date range with what the card still holds", async () => {
    const early = expectOk(await world.book({ date: NEAR, startMinute: h(9), durationMinutes: 60 })); // $88
    const later = expectOk(await world.book({ date: NEAR, startMinute: h(14) })); // $176
    const far = expectOk(await world.book({ date: FAR }));
    await ownerRefund(world.db, later.ref, { amountCents: 5000, reason: "" }, world.manageDeps());

    const list = await listBookings(world.db, { from: NEAR, to: NEAR });
    expect(list.map((b) => b.ref)).toEqual([early.ref, later.ref]);
    expect(list[0]).toMatchObject({ customerName: "Jane Smith", customerPhone: "407-555-0100", totalCents: 8800, cardHeldCents: 8800, refundProblem: false });
    expect(list[1]).toMatchObject({ totalCents: 17600, cardHeldCents: 12600 });
    expect((await listBookings(world.db, { from: NEAR, to: FAR })).map((b) => b.ref)).toEqual([early.ref, later.ref, far.ref]);
    expect(await countUpcoming(world.db, NOW)).toBe(3);
  });

  it("hides cancelled bookings unless asked, and rejects a bad range", async () => {
    const booked = expectOk(await world.book());
    await cancelBooking(world.db, booked.ref, { kind: "owner" }, world.manageDeps());
    expect(await listBookings(world.db, { from: NEAR, to: NEAR })).toEqual([]);
    expect((await listBookings(world.db, { from: NEAR, to: NEAR }, { includeCancelled: true })).map((b) => b.status)).toEqual(["cancelled"]);
    expect(await listBookings(world.db, { from: FAR, to: NEAR })).toEqual([]);
    expect(await listBookings(world.db, { from: "x", to: NEAR })).toEqual([]);
    expect(await countUpcoming(world.db, NOW)).toBe(0);
  });

  it("flags refunds that did not go through", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    world.failRefunds = "Card network down";
    await cancelBooking(world.db, booked.ref, { kind: "token", token: booked.manageToken }, world.manageDeps());
    expect(await listRefundProblems(world.db)).toMatchObject([
      { ref: booked.ref, customerName: "Jane Smith", amountCents: 16720, status: "failed", error: "Card network down" },
    ]);
    const [row] = await listBookings(world.db, { from: FAR, to: FAR }, { includeCancelled: true });
    // The money has not left yet, and it is owed: it cannot be refunded a second time while the refund is tried again.
    expect(row).toMatchObject({ refundProblem: true, cardHeldCents: 880, refundableCents: 880 });
  });
});

describe("codes handed out by the owner", () => {
  it("creates a discount code anyone can use a set number of times, and can cancel it", async () => {
    const created = expectOk(
      await createManualCode(world.db, { kind: "percent", value: 15, email: null, validDays: 30, maxUses: 2, note: "Instagram promo" }, NOW),
    );
    expect(created.code).toMatch(/^VS-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(expectOk(await world.book({ promoCode: created.code })).totalCents).toBe(14960);
    const other = { name: "Eve", email: "eve@example.com", phone: "5550100100" };
    expect((await world.book({ promoCode: created.code, startMinute: h(14), customer: other })).ok).toBe(true);
    expect(await world.book({ promoCode: created.code, date: FAR })).toMatchObject({ ok: false, code: "invalid_code" }); // used twice already

    const [listed] = await listCodes(world.db);
    expect(listed).toMatchObject({ code: created.code, kind: "percent", value: 15, usedCount: 2, maxUses: 2, voided: false, note: "Instagram promo" });
    await voidCode(world.db, listed.id, NOW);
    expect((await listCodes(world.db))[0].voided).toBe(true);
  });

  it("stops a cancelled code from working", async () => {
    const created = expectOk(await createManualCode(world.db, { kind: "amount", value: 5000, email: "jane@example.com", validDays: 30, maxUses: 1, note: "" }, NOW));
    const [listed] = await listCodes(world.db);
    await voidCode(world.db, listed.id, NOW);
    expect(await world.book({ promoCode: created.code })).toMatchObject({ ok: false, message: "That code is not valid." });
  });

  it("takes a code the owner names, kept in capitals as a client's typing is read, and only once", async () => {
    const base = { kind: "percent" as const, value: 15, email: null, validDays: 30, maxUses: 2, note: "" };
    expect(expectOk(await createManualCode(world.db, { ...base, code: " spring-20 " }, NOW)).code).toBe("SPRING-20");
    // A client types it in any case.
    expect(expectOk(await world.book({ promoCode: "Spring-20" })).totalCents).toBe(14960);
    // Taken, in any case.
    expect(await createManualCode(world.db, { ...base, code: "Spring-20" }, NOW)).toEqual({
      ok: false,
      message: "The code SPRING-20 already exists. Choose another.",
    });
    // Too short or too long, other characters, a hyphen at an end, or the shape of the site's own codes.
    for (const code of ["AB", "A".repeat(31), "SPRING_20", "20%OFF", "-SPRING", "SPRING-", "MOVE-ABCD-EFGH", "vs-2345-6789"]) {
      expect((await createManualCode(world.db, { ...base, code }, NOW)).ok, code).toBe(false);
    }
    // Left empty, the site makes one up.
    expect(expectOk(await createManualCode(world.db, { ...base, code: "" }, NOW)).code).toMatch(/^VS-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(await listCodes(world.db)).toHaveLength(2);
  });

  it("validates what the owner types", async () => {
    const base = { kind: "percent" as const, value: 10, email: null, validDays: 30, maxUses: 1, note: "" };
    expect((await createManualCode(world.db, { ...base, value: 101 }, NOW)).ok).toBe(false);
    expect((await createManualCode(world.db, { ...base, value: 0 }, NOW)).ok).toBe(false);
    expect((await createManualCode(world.db, { ...base, validDays: 0 }, NOW)).ok).toBe(false);
    expect((await createManualCode(world.db, { ...base, maxUses: 0 }, NOW)).ok).toBe(false);
    expect((await createManualCode(world.db, { ...base, email: "nope" }, NOW)).ok).toBe(false);
    expect((await createManualCode(world.db, { ...base, kind: "gift" as "percent" }, NOW)).ok).toBe(false);
    expect(await listCodes(world.db)).toEqual([]);
  });
});

describe("settings", () => {
  it("saves a valid setting and applies it", async () => {
    expect(await saveSetting(world.db, "multiStudioPercent", { 2: 10, 3: 15 })).toBe(true);
    expect(await saveSetting(world.db, "minLeadHours", 2)).toBe(true);
    expect(await saveSetting(world.db, "minLeadHours", 4)).toBe(true); // saving again replaces
    const saved = await loadSettings(world.db);
    expect(saved.multiStudioPercent).toEqual({ 2: 10, 3: 15 });
    expect(saved.minLeadHours).toBe(4);
    // The discount is for studios that have no prices together: with the bundle's own price list, it is not used.
    expect(expectOk(await world.book({ studioIds: [world.ids.blanche, world.ids.paris], durationMinutes: 60 })).totalCents).toBe(14000);
    await world.db.delete(bundlePrices);
    expect(expectOk(await world.book({ studioIds: [world.ids.blanche, world.ids.paris], durationMinutes: 60, startMinute: h(14) })).totalCents).toBe(15600 - 1560);
  });

  it("refuses values that make no sense and unknown settings, keeping the old value", async () => {
    for (const [key, value] of [
      ["refundFeePercent", 101],
      ["refundFeePercent", -1],
      ["refundFeePercent", "5"],
      ["loyaltyVisits", 0],
      ["slotIncrementMinutes", 1],
      ["loyaltyEnabled", "yes"],
      ["multiStudioPercent", { 1: 50 }],
      ["multiStudioPercent", { 2: 150 }],
      ["multiStudioPercent", [20]],
      ["isAdmin", true],
    ] as const) {
      expect(await saveSetting(world.db, key, value)).toBe(false);
    }
    expect(await loadSettings(world.db)).toMatchObject({ refundFeePercent: 5, loyaltyVisits: 5, slotIncrementMinutes: 15, multiStudioPercent: { 2: 20, 3: 22 } });
  });
});
