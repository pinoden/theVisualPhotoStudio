import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { combinedStarts } from "@/lib/domain/availability";
import { priceRules, sessions, staffShifts, users } from "@/db/schema";
import {
  addStaff,
  countUpcoming,
  createBlock,
  createManualCode,
  listBlocks,
  listBookings,
  listCodes,
  listRefundProblems,
  listStaff,
  removeBlock,
  removeStaff,
  savePrice,
  saveStudioHours,
  setShift,
  setSpecialDate,
  voidCode,
} from "./admin";
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
      { id: added.id, email: "sam@studio.test", name: "Sam", days: [NEAR, "2026-11-25"] },
    ]);

    expect(await setShift(world.db, added.id, NEAR, false)).toBe(true);
    expect((await listStaff(world.db, "2026-11-14"))[0].days).toEqual(["2026-11-25"]);
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
    expect(await world.book({ studioIds: [world.ids.paris], durationMinutes: 360 })).toMatchObject({ ok: false, code: "invalid_price" });
    expect(await savePrice(world.db, { studioId: world.ids.paris, dayType: "weekday", durationMinutes: 360, priceCents: 34000 })).toBe(true);
    expect(expectOk(await world.book({ studioIds: [world.ids.paris], durationMinutes: 360 })).totalCents).toBe(34000);

    expect(await savePrice(world.db, { studioId: world.ids.blanche, dayType: "weekday", durationMinutes: 60, priceCents: null })).toBe(true);
    expect(await world.book({ durationMinutes: 60, startMinute: h(16) })).toMatchObject({ ok: false, code: "invalid_price" });
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
  it("takes studios off the calendar for a span and gives the time back when removed", async () => {
    const block = expectOk(
      await createBlock(world.db, { studioIds: [world.ids.blanche, world.ids.paris], date: NEAR, startMinute: h(12), endMinute: h(14), note: "Repainting" }),
    );
    const starts = await freeStarts("blanche", NEAR);
    expect(starts).not.toContain(h(12));
    expect(starts).not.toContain(h(13));
    expect(starts).not.toContain(h(11)); // an 11:00 booking could not be cleaned up before the block
    expect(starts).toContain(h(14));
    expect(await freeStarts("dayglow", NEAR)).toContain(h(12));
    expect(await world.book({ startMinute: h(12), durationMinutes: 60 })).toMatchObject({ ok: false, code: "slot_taken" });

    expect(await listBlocks(world.db, NOW)).toEqual([
      {
        id: block.id,
        note: "Repainting",
        studios: ["Studio Blanche", "Studio Paris"],
        startAt: "2026-11-18T17:00:00.000Z",
        endAt: "2026-11-18T19:00:00.000Z",
      },
    ]);

    await removeBlock(world.db, block.id);
    expect(await freeStarts("blanche", NEAR)).toContain(h(12));
    expect(await listBlocks(world.db, NOW)).toEqual([]);
  });

  it("is refused where a booking already is, leaving nothing half-blocked", async () => {
    expectOk(await world.book({ studioIds: [world.ids.paris], startMinute: h(13), durationMinutes: 60 }));
    const result = await createBlock(world.db, {
      studioIds: [world.ids.blanche, world.ids.paris],
      date: NEAR,
      startMinute: h(12),
      endMinute: h(14),
      note: "",
    });
    expect(result).toEqual({ ok: false, message: "A booking or another block already takes part of that time." });
    expect(await listBlocks(world.db, NOW)).toEqual([]);
    expect(await freeStarts("blanche", NEAR)).toContain(h(12)); // Blanche was not blocked either
  });

  it("validates its input", async () => {
    const base = { studioIds: [world.ids.blanche], date: NEAR, startMinute: h(12), endMinute: h(14), note: "" };
    expect((await createBlock(world.db, { ...base, studioIds: [] })).ok).toBe(false);
    expect((await createBlock(world.db, { ...base, date: "2026-02-30" })).ok).toBe(false);
    expect((await createBlock(world.db, { ...base, startMinute: h(14), endMinute: h(12) })).ok).toBe(false);
    expect((await createBlock(world.db, { ...base, studioIds: ["3f2c1e9a-6b7d-4c8e-9f10-112233445566"] })).ok).toBe(false);
    expect((await createBlock(world.db, { ...base, startMinute: 0, endMinute: 1440 })).ok).toBe(true); // a whole day
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
    expect(row).toMatchObject({ refundProblem: true, cardHeldCents: 17600 }); // the money has not left yet
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
    expect(expectOk(await world.book({ studioIds: [world.ids.blanche, world.ids.paris], durationMinutes: 60 })).totalCents).toBe(15600 - 1560);
  });

  it("refuses values that make no sense and unknown settings, keeping the old value", async () => {
    for (const [key, value] of [
      ["refundFeePercent", 101],
      ["refundFeePercent", -1],
      ["refundFeePercent", "5"],
      ["loyaltyPercent", 0],
      ["slotIncrementMinutes", 1],
      ["loyaltyEnabled", "yes"],
      ["multiStudioPercent", { 1: 50 }],
      ["multiStudioPercent", { 2: 150 }],
      ["multiStudioPercent", [20]],
      ["isAdmin", true],
    ] as const) {
      expect(await saveSetting(world.db, key, value)).toBe(false);
    }
    expect(await loadSettings(world.db)).toMatchObject({ refundFeePercent: 5, loyaltyPercent: 10, slotIncrementMinutes: 30, multiStudioPercent: { 2: 20, 3: 22 } });
  });
});
