import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { bookings, photographerHolds, photographers, promoCodes, settings, studioHolds } from "@/db/schema";
import { PROMO_MISFIT_TEXT } from "@/lib/domain/pricing";
import { createManualCode, listCodes, voidCode } from "./admin";
import { moveBooking } from "./appointments";
import type { AuthUser } from "./auth";
import { loadDayAvailability } from "./availability";
import { quoteSelection, toBookingViews } from "./bookings";
import { loadCalendar } from "./calendar";
import { loadCatalog } from "./catalog";
import { cancelBooking, getManageChoices, requestRescheduleCode } from "./manage";
import { MOCK_TOKEN_DECLINED } from "./payments";
import {
  blockPhotographer,
  blockPhotographerDays,
  daysText,
  listPhotoPackages,
  listPhotographerBlocks,
  loadPhotographer,
  savePhotoPackage,
  savePhotographerHours,
  unblockPhotographer,
} from "./photography";
import { issuePromo } from "./promos";
import { createTestWorld, daysAfter, expectOk, FAR, h, hoursAfter, NEAR, NOW, type TestWorld } from "./testing";

let world: TestWorld;
let owner: AuthUser;
let sam: AuthUser; // staff
let jane: AuthUser; // a customer

beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser("owner@studio.test", "owner", "Olivia");
  sam = await world.addUser("sam@studio.test", "staff", "Sam");
  jane = await world.addUser("jane@example.com", "customer", "Jane");
});

const byToken = (token: string) => ({ kind: "token", token }) as const;
/** A Wednesday 18 days ahead: outside the two weeks' notice a session needs. */
const SESSION_DAY = "2026-12-02";
/** The Thursday after it. */
const NEXT_DAY = "2026-12-03";
/** A photography session: Blanche, SESSION_DAY, 10:00, one hour, unless said otherwise. */
const session = (overrides: Parameters<TestWorld["book"]>[0] = {}) =>
  world.book({ photography: true, date: SESSION_DAY, durationMinutes: 60, ...overrides });
/** A studio rental on the same day. */
const rental = (overrides: Parameters<TestWorld["book"]>[0] = {}) => world.book({ date: SESSION_DAY, ...overrides });
const range = (column: typeof studioHolds.occupied | typeof photographerHolds.occupied) => ({
  from: sql<Date>`lower(${column})`,
  to: sql<Date>`upper(${column})`,
});
const iso = (value: Date) => new Date(value).toISOString();

describe("what is on sale", () => {
  it("is the packages of the live price list: a price for each studio and length, studio included", async () => {
    const catalog = await loadCatalog(world.db);
    const byStudio = (slug: string) =>
      catalog.photoPackages.filter((p) => p.studioId === world.ids[slug]).map((p) => [p.durationMinutes, p.priceCents, p.includes]);
    expect(byStudio("blanche")).toEqual([
      [60, 37500, "1–2 outfits, 20 edited images"],
      [120, 57500, "2–3 outfits, 30 edited images"],
      [180, 73000, "3–4 outfits, 40 edited images"],
      [240, 84000, "4–5 outfits, 50 edited images"],
    ]);
    expect(byStudio("dayglow").map((p) => p[1])).toEqual([31500, 51500, 67000, 77500]);
    expect(byStudio("paris").map((p) => p[1])).toEqual([31500, 51500, 67000]); // no four-hour session in Paris
  });

  it("is nothing when there is no photographer to book", async () => {
    await world.db.update(photographers).set({ active: false });
    expect((await loadCatalog(world.db)).photoPackages).toEqual([]);
    expect(await session()).toMatchObject({ ok: false, code: "invalid_price" });
  });
});

describe("booking a photography session", () => {
  it("charges the package's price and holds the studio and the photographer for the time", async () => {
    const booked = expectOk(await session());
    expect(booked.totalCents).toBe(37500);
    expect(world.charges.at(-1)?.amountCents).toBe(37500);

    const [booking] = await world.db.select().from(bookings).where(eq(bookings.ref, booked.ref));
    const photographer = (await loadPhotographer(world.db))!;
    expect(booking).toMatchObject({ status: "confirmed", photographerId: photographer.id, photoIncludes: "1–2 outfits, 20 edited images" });
    expect((await toBookingViews(world.db, [booking]))[0].photography).toEqual({ includes: "1–2 outfits, 20 edited images" });

    // Both are held from 10:00 to 11:15: the hour, and the 15 minutes kept free after it.
    const [studio] = await world.db.select(range(studioHolds.occupied)).from(studioHolds).where(eq(studioHolds.bookingId, booking.id));
    const [person] = await world.db
      .select({ ...range(photographerHolds.occupied), photographerId: photographerHolds.photographerId })
      .from(photographerHolds)
      .where(eq(photographerHolds.bookingId, booking.id));
    expect([iso(studio.from), iso(studio.to)]).toEqual(["2026-12-02T15:00:00.000Z", "2026-12-02T16:15:00.000Z"]);
    expect([iso(person.from), iso(person.to)]).toEqual(["2026-12-02T15:00:00.000Z", "2026-12-02T16:15:00.000Z"]);
    expect(person.photographerId).toBe(photographer.id);

    const mail = (await world.emails("booking_confirmation")).at(-1)!;
    expect(mail.body).toContain("Photography session with our in-house photographer, studio included: 1–2 outfits, 20 edited images.");
    expect(mail.body).toContain("Total: $375");
  });

  it("holds the photographer whatever the studio: nobody else can book them for the same time", async () => {
    expectOk(await session({ durationMinutes: 120 })); // Blanche, 10:00 to 12:00

    // Another session, in another studio, at an overlapping time: the studio is free, the photographer is not.
    const clash = await session({ studioIds: [world.ids.paris], startMinute: h(11) });
    expect(clash).toMatchObject({ ok: false, code: "slot_taken", message: "Our photographer is not free at that time. Please choose another." });
    // Nor straight after: the photographer keeps the same 15 minutes between sessions as a studio does.
    expect(await session({ studioIds: [world.ids.paris], startMinute: h(12) })).toMatchObject({ ok: false, code: "slot_taken" });
    expect(await session({ studioIds: [world.ids.dayglow], startMinute: h(9) })).toMatchObject({ ok: false, code: "slot_taken" });

    // Renting Paris without a photographer at that time is fine: only the photographer is taken.
    expect((await rental({ studioIds: [world.ids.paris], startMinute: h(11), durationMinutes: 60 })).ok).toBe(true);
    // And a session 15 minutes after the first one ends is fine.
    expect((await session({ studioIds: [world.ids.dayglow], startMinute: h(12) + 15 })).ok).toBe(true);
  });

  it("is refused by the database itself when two requests for the photographer arrive at once", async () => {
    const results = await Promise.all([
      session({ studioIds: [world.ids.blanche] }),
      session({ studioIds: [world.ids.dayglow], customer: { name: "Bob Brown", email: "bob@example.com", phone: "407-555-0111" } }),
      session({ studioIds: [world.ids.paris], customer: { name: "Cleo Cruz", email: "cleo@example.com", phone: "407-555-0122" } }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(world.charges).toHaveLength(1);
    expect(await world.db.select().from(photographerHolds).where(eq(photographerHolds.active, true))).toHaveLength(1);
    // The two that lost hold nothing.
    expect(await world.db.select().from(studioHolds).where(eq(studioHolds.active, true))).toHaveLength(1);
  });

  it("needs a studio that is free too", async () => {
    expectOk(await rental({ startMinute: h(10), durationMinutes: 60 })); // Blanche is rented
    expect(await session()).toMatchObject({ ok: false, code: "slot_taken", message: "That time is no longer available. Please choose another." });
    expect((await session({ studioIds: [world.ids.paris] })).ok).toBe(true);
  });

  it("is for one studio and a length that is on sale", async () => {
    expect(await session({ studioIds: [world.ids.blanche, world.ids.paris] })).toMatchObject({ ok: false, code: "invalid_price" });
    expect(await session({ durationMinutes: 90 })).toMatchObject({ ok: false, code: "invalid_price" });
    expect(await session({ studioIds: [world.ids.paris], durationMinutes: 240 })).toMatchObject({ ok: false, code: "invalid_price" });
    expect(world.charges).toHaveLength(0);
  });

  it("frees the photographer again when the card is declined", async () => {
    expect(await session({ paymentToken: MOCK_TOKEN_DECLINED })).toMatchObject({ ok: false, code: "payment_failed" });
    expect(await world.db.select().from(photographerHolds).where(eq(photographerHolds.active, true))).toHaveLength(0);
    expect((await session({ studioIds: [world.ids.paris] })).ok).toBe(true);
  });

  it("rejects rental discounts, free hours and all studio credit before spending or charging anything", async () => {
    const forJane = { email: jane.email, expiresAt: daysAfter(NOW, 30) };
    const percent = (await issuePromo(world.db, { ...forJane, kind: "percent", value: 10, source: "manual" }))!;
    const freeHour = (await issuePromo(world.db, { ...forJane, kind: "free_hour", value: 60, source: "loyalty" }))!;
    const manual = (await issuePromo(world.db, { ...forJane, kind: "amount", value: 4000, source: "manual" }))!;
    const pet = (await issuePromo(world.db, { ...forJane, kind: "amount", value: 4000, source: "pet_fee" }))!;
    const paid = expectOk(await world.book({ date: FAR }));
    const credit = expectOk(await requestRescheduleCode(world.db, paid.ref, byToken(paid.manageToken), world.manageDeps()));
    const refusal = { ok: false, status: 422, code: "invalid_code", message: PROMO_MISFIT_TEXT.photography };
    for (const { code } of [percent, freeHour, manual, pet, credit]) {
      expect(await session({ promoCode: code })).toEqual(refusal);
      expect(
        await quoteSelection(world.db, { studioIds: [world.ids.blanche], date: SESSION_DAY, durationMinutes: 60, photography: true, promoCode: code, email: jane.email }, NOW),
      ).toEqual(refusal);
    }
    expect(world.charges).toHaveLength(1); // only the rental
    expect((await world.db.select().from(promoCodes)).every((code) => code.usedCount === 0)).toBe(true);
    expect(expectOk(await rental({ promoCode: credit.code })).totalCents).toBe(0);
  });

  it("applies an owner-created photography discount only to photography and honours a cancellation of the code", async () => {
    const discount = expectOk(await createManualCode(world.db, {
      kind: "percent", value: 20, photographyOnly: true, email: jane.email, validDays: 30, maxUses: 2, note: "",
    }, NOW));
    const input = { studioIds: [world.ids.blanche], date: SESSION_DAY, durationMinutes: 60, promoCode: discount.code, email: jane.email };
    expect(await quoteSelection(world.db, input, NOW)).toMatchObject({ ok: false, message: PROMO_MISFIT_TEXT.rental });
    expect(await rental({ promoCode: discount.code })).toMatchObject({ ok: false, message: PROMO_MISFIT_TEXT.rental });
    expect(await quoteSelection(world.db, { ...input, photography: true }, NOW)).toMatchObject({
      ok: true,
      promo: { photographyOnly: true },
      quote: { totalCents: 30000 },
    });
    expect(expectOk(await session({ promoCode: discount.code })).totalCents).toBe(30000);
    expect(world.charges.at(-1)?.amountCents).toBe(30000);
    const [listed] = await listCodes(world.db);
    expect(listed).toMatchObject({ code: discount.code, photographyOnly: true, usedCount: 1 });
    await voidCode(world.db, listed.id, NOW);
    expect(await session({ date: NEXT_DAY, promoCode: discount.code })).toMatchObject({ ok: false, message: "That code is not valid." });
  });
});

describe("the photographer's availability", () => {
  it("limits sessions to the hours they are ready to work, and leaves rentals alone", async () => {
    // Wednesdays from 1:00 PM to 5:00 PM only.
    expect(await savePhotographerHours(world.db, owner, 3, { openMinute: h(13), closeMinute: h(17) })).toBe(true);
    expect(await session({ startMinute: h(10) })).toMatchObject({ ok: false, code: "slot_taken" });
    expect(await session({ startMinute: h(16) + 15 })).toMatchObject({ ok: false, code: "slot_taken" }); // would run past 5:00
    expect((await session({ startMinute: h(13) })).ok).toBe(true);
    expect((await rental({ studioIds: [world.ids.paris], startMinute: h(10), durationMinutes: 60 })).ok).toBe(true);

    // A day off: no session at all that day.
    expect(await savePhotographerHours(world.db, owner, 4, null)).toBe(true);
    expect(await session({ date: NEXT_DAY })).toMatchObject({ ok: false, code: "slot_taken" });
    expect((await loadPhotographer(world.db))!.hours[4]).toBeUndefined();
  });

  it("follows the studio's start times even when their own hours begin off the quarter hour", async () => {
    await savePhotographerHours(world.db, owner, 3, { openMinute: h(9) + 40, closeMinute: h(17) });
    expect(await session({ startMinute: h(9) + 30 })).toMatchObject({ ok: false, code: "slot_taken" }); // before they start
    expect((await session({ startMinute: h(9) + 45 })).ok).toBe(true);
  });

  it("can be blocked for part of a day, and opened again", async () => {
    const blocked = await blockPhotographer(world.db, owner, { date: SESSION_DAY, startMinute: h(9), endMinute: h(12), note: "Wedding shoot" });
    expect(blocked.ok).toBe(true);
    expect(await session({ startMinute: h(11) })).toMatchObject({ ok: false, code: "slot_taken" });
    expect(await session({ startMinute: h(8) + 45 })).toMatchObject({ ok: false, code: "slot_taken" });
    expect((await session({ startMinute: h(12) })).ok).toBe(true); // from the moment the block ends

    const blocks = await listPhotographerBlocks(world.db, NOW);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ startAt: "2026-12-02T14:00:00.000Z", endAt: "2026-12-02T17:00:00.000Z", note: "Wedding shoot" });

    expect(await unblockPhotographer(world.db, owner, blocks[0].id)).toBe(true);
    expect(await listPhotographerBlocks(world.db, NOW)).toHaveLength(0);
    expect((await session({ studioIds: [world.ids.paris], startMinute: h(10) })).ok).toBe(true);
  });

  it("takes whole days off, one or several in a row, the time blocked inside them joined in (question 70)", async () => {
    // An hour already blocked on the Thursday becomes part of the days off.
    expect((await blockPhotographer(world.db, owner, { date: NEXT_DAY, startMinute: h(14), endMinute: h(15), note: "Dentist" })).ok).toBe(true);
    const off = await blockPhotographerDays(world.db, owner, { from: SESSION_DAY, to: "2026-12-04", note: "Holiday" }, NOW);
    expect(off.ok).toBe(true);
    const blocks = await listPhotographerBlocks(world.db, NOW);
    expect(blocks).toEqual([
      { id: off.ok ? off.id : "", startAt: "2026-12-02T05:00:00.000Z", endAt: "2026-12-05T05:00:00.000Z", note: "Holiday", days: { from: SESSION_DAY, to: "2026-12-04" } },
    ]);
    expect(daysText(blocks[0].days!)).toBe("Wednesday, December 2, 2026 to Friday, December 4, 2026");
    for (const date of [SESSION_DAY, NEXT_DAY, "2026-12-04"]) {
      expect(await session({ date, startMinute: h(9) })).toMatchObject({ ok: false, code: "slot_taken" });
      expect(await session({ date, startMinute: h(16) })).toMatchObject({ ok: false, code: "slot_taken" });
    }
    expect((await session({ date: "2026-12-05", startMinute: h(9) })).ok).toBe(true); // the Saturday after
    expect((await rental({ date: NEXT_DAY, startMinute: h(10) })).ok).toBe(true); // the studios stay open

    // One day, the last left empty; across the clocks' change, still whole days.
    const single = await blockPhotographerDays(world.db, owner, { from: "2026-12-10", to: "", note: "" }, NOW);
    expect(single.ok).toBe(true);
    const spring = await blockPhotographerDays(world.db, owner, { from: "2027-03-13", to: "2027-03-15", note: "" }, NOW);
    expect(spring.ok).toBe(true);
    expect((await listPhotographerBlocks(world.db, NOW)).map((block) => block.days)).toEqual([
      { from: SESSION_DAY, to: "2026-12-04" },
      { from: "2026-12-10", to: "2026-12-10" },
      { from: "2027-03-13", to: "2027-03-15" },
    ]);
    // Some hours of a day are not whole days.
    await blockPhotographer(world.db, owner, { date: "2026-12-16", startMinute: h(9), endMinute: h(12), note: "" });
    expect((await listPhotographerBlocks(world.db, NOW)).find((block) => block.startAt.startsWith("2026-12-16"))!.days).toBeNull();

    // Removing it opens every day again.
    expect(await unblockPhotographer(world.db, owner, off.ok ? off.id : "")).toBe(true);
    expect((await session({ date: NEXT_DAY, startMinute: h(16) })).ok).toBe(true);
  });

  it("refuses whole days over a booked session, naming it, and days that cannot be", async () => {
    const booked = expectOk(await session({ date: FAR, startMinute: h(11) }));
    expect(await blockPhotographerDays(world.db, owner, { from: "2026-12-08", to: "2026-12-10", note: "" }, NOW)).toEqual({
      ok: false,
      message: `The photographer has a session on those days: ${booked.ref} (Jane Smith, Wed, Dec 9, 2026, 11:00 AM). Move or cancel it first, or leave that day out.`,
    });
    expect(await listPhotographerBlocks(world.db, NOW)).toEqual([]);

    expect(await blockPhotographerDays(world.db, owner, { from: "2026-12-10", to: "2026-12-08", note: "" }, NOW)).toEqual({ ok: false, message: "The last day cannot be before the first." });
    expect(await blockPhotographerDays(world.db, owner, { from: "2026-11-13", to: "", note: "" }, NOW)).toEqual({ ok: false, message: "Choose days from today on." });
    expect(await blockPhotographerDays(world.db, owner, { from: "2026-12-01", to: "2027-12-02", note: "" }, NOW)).toEqual({ ok: false, message: "Block at most 366 days at a time." });
    expect(await blockPhotographerDays(world.db, owner, { from: "next week", to: "", note: "" }, NOW)).toEqual({ ok: false, message: "Choose valid days." });
    expect(await blockPhotographerDays(world.db, sam, { from: "2026-12-14", to: "", note: "" }, NOW)).toMatchObject({ ok: false });

    // Days inside a longer block taken off before are not laid over it.
    expect((await blockPhotographerDays(world.db, owner, { from: "2026-12-14", to: "2026-12-16", note: "" }, NOW)).ok).toBe(true);
    expect(await blockPhotographerDays(world.db, owner, { from: "2026-12-15", to: "", note: "" }, NOW)).toEqual({
      ok: false,
      message: "Time blocked before reaches into those days from outside them: remove that block first, or choose days around it.",
    });

    // Staff may, once the owners switch it on.
    await world.db.insert(settings).values({ key: "staffSetsPhotographerTimes", value: true });
    expect((await blockPhotographerDays(world.db, sam, { from: "2026-12-21", to: "2026-12-22", note: "" }, NOW)).ok).toBe(true);
  });

  it("cannot be blocked over a session that is already booked, and a session's hold is never removed as a block", async () => {
    const booked = expectOk(await session());
    expect(await blockPhotographer(world.db, owner, { date: SESSION_DAY, startMinute: h(9), endMinute: h(12), note: "" })).toEqual({
      ok: false,
      message: "A photography session or another block already takes part of that time.",
    });
    expect(await blockPhotographer(world.db, owner, { date: SESSION_DAY, startMinute: h(12), endMinute: h(11), note: "" })).toMatchObject({ ok: false });
    expect(await blockPhotographer(world.db, owner, { date: "tomorrow", startMinute: h(9), endMinute: h(12), note: "" })).toMatchObject({ ok: false });

    const [hold] = await world.db.select().from(photographerHolds);
    expect(await unblockPhotographer(world.db, owner, hold.id)).toBe(false);
    expect((await world.db.select().from(photographerHolds))[0]).toMatchObject({ active: true, bookingId: hold.bookingId });
    expect(booked.ok).toBe(true);
  });

  it("is reported with the day's availability, for the booking screen", async () => {
    await blockPhotographer(world.db, owner, { date: SESSION_DAY, startMinute: h(14), endMinute: h(15), note: "" });
    expectOk(await session());
    const catalog = await loadCatalog(world.db);
    const day = await loadDayAvailability(world.db, catalog, SESSION_DAY, NOW, { withPhotographer: true });
    expect(day.photographer).toMatchObject({
      openMinute: h(9),
      closeMinute: h(17), // 9 am to 5 pm, the owner's answer of 2026-11-15
      bufferMinutes: 15,
      anyStart: true,
      busy: [
        { start: h(10), end: h(11) + 15 },
        { start: h(14), end: h(15) },
      ],
    });
    // It is not part of an ordinary request for a day.
    expect((await loadDayAvailability(world.db, catalog, SESSION_DAY, NOW)).photographer).toBeUndefined();
  });

  it("starts at 9 am to 5 pm on every day, so the last one-hour session starts at 4 pm", async () => {
    const hours = (await loadPhotographer(world.db))!.hours;
    for (let weekday = 1; weekday <= 7; weekday++) expect(hours[weekday]).toEqual({ openMinute: h(9), closeMinute: h(17) });

    expect((await session({ startMinute: h(16) })).ok).toBe(true); // 4:00 to 5:00 PM
    expect(await session({ studioIds: [world.ids.paris], startMinute: h(16) + 15 })).toMatchObject({ ok: false, code: "slot_taken" });
    // A two-hour session has to start by 3 pm. The studio itself is open until 7.
    expect(await session({ studioIds: [world.ids.paris], startMinute: h(16), durationMinutes: 120 })).toMatchObject({ ok: false, code: "slot_taken" });
    expect((await rental({ studioIds: [world.ids.paris], startMinute: h(17), durationMinutes: 120 })).ok).toBe(true);
  });

  it("is the owners' to set, and staff's only once the owners switch it on", async () => {
    const block = { date: NEAR, startMinute: h(9), endMinute: h(10), note: "" };
    expect(await savePhotographerHours(world.db, sam, 3, null)).toBe(false);
    expect(await blockPhotographer(world.db, sam, block)).toMatchObject({ ok: false });
    expect(await savePhotographerHours(world.db, jane, 3, null)).toBe(false);

    await world.db.insert(settings).values({ key: "staffSetsPhotographerTimes", value: true });
    expect(await savePhotographerHours(world.db, sam, 3, { openMinute: h(10), closeMinute: h(18) })).toBe(true);
    const made = await blockPhotographer(world.db, sam, block);
    expect(made.ok).toBe(true);
    expect(await unblockPhotographer(world.db, jane, made.ok ? made.id : "")).toBe(false);
    expect(await savePhotographerHours(world.db, sam, 8, null)).toBe(false);
    expect(await savePhotographerHours(world.db, sam, 3, { openMinute: h(18), closeMinute: h(10) })).toBe(false);
  });
});

describe("the notice a session needs", () => {
  const TOO_SOON = "Photography sessions are made at least 14 days ahead. Please choose a later date.";

  it("is two weeks: the photographer cannot be booked closer than that, while a studio can", async () => {
    // Now is Saturday the 14th at 10:00. Four days ahead, and thirteen days ahead, are too soon.
    expect(await session({ date: NEAR })).toEqual({ ok: false, status: 409, code: "slot_taken", message: TOO_SOON });
    expect(await session({ date: "2026-11-27" })).toMatchObject({ ok: false, message: TOO_SOON });
    expect(world.charges).toHaveLength(0);
    // Exactly two weeks ahead to the minute is in time; a quarter of an hour sooner is not.
    expect(await session({ date: "2026-11-28", startMinute: h(9) + 45 })).toMatchObject({ ok: false, message: TOO_SOON });
    expect((await session({ date: "2026-11-28", startMinute: h(10) })).ok).toBe(true);
    // Renting a studio keeps its own 24 hours.
    expect((await world.book({ date: NEAR })).ok).toBe(true);
  });

  it("is what the booking screen is told, so it offers no time inside it", async () => {
    const catalog = await loadCatalog(world.db);
    expect((await loadDayAvailability(world.db, catalog, NEAR, NOW, { withPhotographer: true })).earliestStartMinute).toBe(1440);
    expect((await loadDayAvailability(world.db, catalog, "2026-11-28", NOW, { withPhotographer: true })).earliestStartMinute).toBe(h(10));
    expect((await loadDayAvailability(world.db, catalog, SESSION_DAY, NOW, { withPhotographer: true })).earliestStartMinute).toBe(0);
    // The same day asked about for a rental: only the ordinary notice.
    expect((await loadDayAvailability(world.db, catalog, NEAR, NOW)).earliestStartMinute).toBe(0);
  });

  it("follows the owner's setting, and is never shorter than the notice for a rental", async () => {
    await world.db.insert(settings).values({ key: "photoMinLeadHours", value: 72 });
    expect((await session({ date: NEAR })).ok).toBe(true); // four days ahead
    await world.db.update(settings).set({ value: 0 }).where(eq(settings.key, "photoMinLeadHours"));
    // With no notice of its own, a session still needs the 24 hours every booking needs.
    expect(await session({ date: "2026-11-15", startMinute: h(9), studioIds: [world.ids.paris] })).toMatchObject({
      ok: false,
      message: "Photography sessions are made at least 24 hours ahead. Please choose a later date.",
    });
    expect((await session({ date: "2026-11-15", startMinute: h(10), studioIds: [world.ids.paris] })).ok).toBe(true);
  });
});

describe("the packages", () => {
  it("can be repriced and taken off sale by the owners only; a booked session keeps what it was sold with", async () => {
    const booked = expectOk(await session());
    const [oneHour] = (await listPhotoPackages(world.db)).filter((p) => p.studioName === "Studio Blanche");
    expect(oneHour).toMatchObject({ durationMinutes: 60, priceCents: 37500, active: true });

    expect(await savePhotoPackage(world.db, sam, oneHour.id, { priceCents: 100, includes: "", active: true })).toBe(false);
    expect(await savePhotoPackage(world.db, owner, oneHour.id, { priceCents: 39900, includes: "  2 outfits,  25 edited images ", active: true })).toBe(true);
    expect((await loadCatalog(world.db)).photoPackages.find((p) => p.id === oneHour.id)).toMatchObject({
      priceCents: 39900,
      includes: "2 outfits, 25 edited images",
    });
    const [kept] = await world.db.select().from(bookings).where(eq(bookings.ref, booked.ref));
    expect(kept).toMatchObject({ totalCents: 37500, photoIncludes: "1–2 outfits, 20 edited images" });

    expect(await savePhotoPackage(world.db, owner, oneHour.id, { priceCents: 39900, includes: "", active: false })).toBe(true);
    expect(await session({ startMinute: h(14) })).toMatchObject({ ok: false, code: "invalid_price" });
    expect(await savePhotoPackage(world.db, owner, oneHour.id, { priceCents: -1, includes: "", active: true })).toBe(false);
    expect(await savePhotoPackage(world.db, owner, "not-an-id", { priceCents: 1, includes: "", active: true })).toBe(false);
  });
});

describe("after a session is booked", () => {
  it("is refunded when cancelled 14 days or more ahead, and frees the studio and the photographer", async () => {
    // Booked 18 days ahead, and cancelled eight days later: ten days before the session.
    const soon = expectOk(await session());
    const tenDaysBefore = daysAfter(NOW, 8);
    const choices = await getManageChoices(world.db, soon.ref, byToken(soon.manageToken), tenDaysBefore);
    expect(choices?.cancel.text).toBe("No refund is due, because the booking starts in less than 14 days.");
    const cancelled = expectOk(await cancelBooking(world.db, soon.ref, byToken(soon.manageToken), world.manageDeps({ now: tenDaysBefore })));
    expect(cancelled.refundCents).toBe(0);
    expect(await world.db.select().from(photographerHolds).where(eq(photographerHolds.active, true))).toHaveLength(0);
    // The time can be booked again, by someone else, in another studio.
    expect((await session({ studioIds: [world.ids.paris] })).ok).toBe(true);

    // Twenty-five days ahead: refunded, less the fee.
    const later = expectOk(await session({ date: FAR }));
    const refunded = expectOk(await cancelBooking(world.db, later.ref, byToken(later.manageToken), world.manageDeps()));
    expect(refunded.refundCents).toBe(37500 - 1875);
  });

  it("keeps its own refund window when the owners give rentals a different one", async () => {
    await world.db.insert(settings).values({ key: "refundWindowHours", value: 168 }); // rentals: 7 days, as they are by default
    const booked = expectOk(await session());
    const paris = expectOk(await rental({ studioIds: [world.ids.paris], durationMinutes: 60 }));
    const tenDaysBefore = hoursAfter(NOW, 8 * 24);
    const deps = world.manageDeps({ now: tenDaysBefore });
    // Ten days before: the rental is refunded, the session is not.
    expect(expectOk(await cancelBooking(world.db, paris.ref, byToken(paris.manageToken), deps)).refundCents).toBe(6800 - 340);
    expect(expectOk(await cancelBooking(world.db, booked.ref, byToken(booked.manageToken), deps)).refundCents).toBe(0);
  });

  it("frees the photographer and sends a credit to rebook photography when a customer reschedules", async () => {
    const booked = expectOk(await session());
    const credit = expectOk(await requestRescheduleCode(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    expect(await world.db.select().from(photographerHolds).where(eq(photographerHolds.active, true))).toHaveLength(0);
    expect(credit.bookPath).toBe("/book/photography");
    expect((await world.emails("reschedule_code"))[0].body).toContain("https://studio.test/book/photography");
    expect(await rental({ promoCode: credit.code })).toMatchObject({ ok: false, message: PROMO_MISFIT_TEXT.rental });
    expect(expectOk(await session({ date: NEXT_DAY, promoCode: credit.code })).totalCents).toBe(0);
    expect(world.charges).toHaveLength(1);
  });

  it("is moved by an administrator together with its photographer, only to a time when both are free", async () => {
    const first = expectOk(await session()); // Blanche, 10:00 to 11:00
    expectOk(await session({ studioIds: [world.ids.paris], startMinute: h(14) })); // Paris, 2:00 to 3:00

    const to = (startMinute: number) => ({ date: SESSION_DAY, startMinute, countsAsClientMove: false });
    // Blanche is free at 2:30, but the photographer is in Paris then.
    expect(await moveBooking(world.db, owner, first.ref, to(h(14) + 30), NOW)).toEqual({
      ok: false,
      reason: "slot_taken",
      message: "The photographer is not free at that time. Choose another.",
    });
    expect(await moveBooking(world.db, owner, first.ref, to(h(15)), NOW)).toMatchObject({ ok: false, reason: "slot_taken" }); // no gap
    expect(await moveBooking(world.db, owner, first.ref, to(h(15) + 15), NOW)).toMatchObject({ ok: true });

    const [booking] = await world.db.select().from(bookings).where(eq(bookings.ref, first.ref));
    const [person] = await world.db.select(range(photographerHolds.occupied)).from(photographerHolds).where(eq(photographerHolds.bookingId, booking.id));
    expect([iso(person.from), iso(person.to)]).toEqual(["2026-12-02T20:15:00.000Z", "2026-12-02T21:30:00.000Z"]); // 3:15 to 4:30 PM
    // The morning is the photographer's again.
    expect((await session({ studioIds: [world.ids.dayglow], startMinute: h(10) })).ok).toBe(true);
  });

  it("is marked as photography on the calendar", async () => {
    const booked = expectOk(await session());
    expectOk(await rental({ studioIds: [world.ids.paris], durationMinutes: 60 }));
    const calendar = await loadCalendar(world.db, owner, await loadCatalog(world.db), { from: SESSION_DAY, to: NEXT_DAY });
    expect(calendar.appointments.map((entry) => [entry.ref === booked.ref, entry.photography])).toEqual(
      expect.arrayContaining([
        [true, true],
        [false, false],
      ]),
    );
  });
});
