import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookings, photographerHolds, photographers, settings } from "@/db/schema";
import { PROMO_MISFIT_TEXT } from "@/lib/domain/pricing";
import { createManualCode } from "./admin";
import { moveBooking } from "./appointments";
import type { AuthUser } from "./auth";
import { loadDayAvailability } from "./availability";
import { quoteSelection, toBookingViews } from "./bookings";
import { loadCalendar } from "./calendar";
import { loadCatalog } from "./catalog";
import { requestRescheduleCode } from "./manage";
import { loadMonthFits } from "./month-availability";
import { addPhotoPackage, blockPhotographerDays, listPhotoPackages, loadPhotographer, savePhotographerHours } from "./photography";
import { createTestWorld, expectOk, h, NOW, type TestWorld } from "./testing";
import { joinWaitlist } from "./waitlist";

/**
 * Content Creation (the owner's answer of 2026-11-23: "it's when I'm creating reels/stories for a customer using
 * iPhone, that's similar to a session with a photographer"; question 69 in ProjectLibrary.md): its own person, hours,
 * days off and sessions; photography's notice, refund window, codes and forms for sessions.
 */
let world: TestWorld;
let owner: AuthUser;
let sam: AuthUser; // staff

beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser("owner@studio.test", "owner", "Olivia");
  sam = await world.addUser("sam@studio.test", "staff", "Sam");
});

/** A Wednesday 18 days ahead, past the two weeks' notice of a session. */
const DAY = "2026-12-02";
const byToken = (token: string) => ({ kind: "token", token }) as const;
const content = (overrides: Parameters<TestWorld["book"]>[0] = {}) =>
  world.book({ photography: true, service: "content", studioIds: [world.ids.paris], date: DAY, durationMinutes: 60, ...overrides });
const photoSession = (overrides: Parameters<TestWorld["book"]>[0] = {}) => world.book({ photography: true, date: DAY, durationMinutes: 60, ...overrides });
const onSale = () =>
  addPhotoPackage(world.db, owner, "content", { studioId: world.ids.paris, durationMinutes: 60, priceCents: 15000, includes: "3 reels and 5 stories" });

describe("Content Creation", () => {
  it("has its own person from the start, and nothing on sale until the owners add a session", async () => {
    const creator = await loadPhotographer(world.db, "content");
    expect(creator).toMatchObject({ name: "In-house content creator" });
    expect(creator!.hours[3]).toEqual({ openMinute: h(9), closeMinute: h(17) });
    expect((await loadPhotographer(world.db))!.name).toBe("In-house photographer"); // photography's is still the photographer
    expect((await loadCatalog(world.db)).photoPackages.filter((pack) => pack.service === "content")).toEqual([]);
    expect(await content()).toMatchObject({ ok: false, code: "invalid_price", message: "That content creation session is not offered. Please choose a studio and a length from the list." });

    expect(await addPhotoPackage(world.db, sam, "content", { studioId: world.ids.paris, durationMinutes: 60, priceCents: 15000, includes: "" })).toEqual({ ok: false, message: "Only an owner can put a session on sale." });
    expect(await addPhotoPackage(world.db, owner, "content", { studioId: world.ids.paris, durationMinutes: 50, priceCents: 15000, includes: "" })).toMatchObject({ ok: false });
    expect(await addPhotoPackage(world.db, owner, "content", { studioId: world.ids.paris, durationMinutes: 60, priceCents: 0, includes: "" })).toEqual({ ok: false, message: "Enter the session's price." });
    expectOk(await onSale());
    expect(await onSale()).toEqual({ ok: false, message: "Studio Paris has a content creation session of that length already: change it below." });
    expect((await listPhotoPackages(world.db, "content")).map((pack) => [pack.studioName, pack.durationMinutes, pack.priceCents, pack.includes])).toEqual([["Studio Paris", 60, 15000, "3 reels and 5 stories"]]);
    // Photography's sessions are photography's alone.
    expect((await listPhotoPackages(world.db)).some((pack) => pack.includes === "3 reels and 5 stories")).toBe(false);
    expect((await loadCatalog(world.db)).photoPackages.filter((pack) => pack.service === "content")).toMatchObject([{ studioId: world.ids.paris, durationMinutes: 60, priceCents: 15000 }]);
  });

  it("books a session that holds the studio and the content creator, not the photographer", async () => {
    expectOk(await onSale());
    const booked = expectOk(await content({ startMinute: h(10) }));
    expect(booked.totalCents).toBe(15000);
    const [row] = await world.db.select().from(bookings).where(eq(bookings.ref, booked.ref));
    const [creator] = await world.db.select().from(photographers).where(eq(photographers.service, "content"));
    expect(row.photographerId).toBe(creator.id);
    expect(await world.db.select({ id: photographerHolds.photographerId }).from(photographerHolds).where(eq(photographerHolds.bookingId, row.id))).toEqual([{ id: creator.id }]);
    expect((await toBookingViews(world.db, [row]))[0].photography).toEqual({ includes: "3 reels and 5 stories", service: "content" });

    // The photographer is free at the same time, in another studio; the content creator is not.
    expectOk(await photoSession({ studioIds: [world.ids.blanche], startMinute: h(10) }));
    expect(await content({ studioIds: [world.ids.paris], startMinute: h(10) + 30, customer: { name: "Bob Brown", email: "bob@example.com", phone: "407-555-0101" } })).toMatchObject({ ok: false, code: "slot_taken" });

    // The email says whose session it is, and nothing of edited images.
    const mail = (await world.emails("booking_confirmation")).at(0)!;
    expect(mail.body).toContain("Content creation session with our in-house content creator, studio included: 3 reels and 5 stories.");
    expect(mail.body).not.toContain("edited images");

    // On the calendar: content creation's.
    const calendar = await loadCalendar(world.db, owner, await loadCatalog(world.db), { from: DAY, to: "2026-12-03" });
    expect(calendar.appointments.map((entry) => entry.photography).sort()).toEqual(["content", "photography"]);
  });

  it("follows the content creator's hours and days off, and photography's notice", async () => {
    expectOk(await onSale());
    // Three business days' notice (the owner's answer of 2026-11-23): booked on Saturday, November 14, the first day is
    // Wednesday, November 18; photography keeps its two weeks.
    expect(await content({ date: "2026-11-17", startMinute: h(10) })).toMatchObject({
      ok: false,
      code: "slot_taken",
      message: "Content creation sessions are made at least 3 business days ahead. Please choose a later date.",
    });
    expectOk(await content({ date: "2026-11-18", startMinute: h(10) }));
    expect(await photoSession({ date: "2026-11-18", startMinute: h(10), studioIds: [world.ids.blanche] })).toMatchObject({ ok: false, code: "slot_taken" });
    // Wednesdays from 1 to 5 only, for the content creator; the photographer keeps 9 to 5.
    expect(await savePhotographerHours(world.db, owner, 3, { openMinute: h(13), closeMinute: h(17) }, "content")).toBe(true);
    expect(await content({ startMinute: h(10) })).toMatchObject({ ok: false, code: "slot_taken", message: "Our content creator is not free at that time. Please choose another." });
    expectOk(await photoSession({ startMinute: h(10) }));
    expectOk(await content({ startMinute: h(13) }));
    // A day off for the content creator leaves photography alone.
    expectOk(await blockPhotographerDays(world.db, owner, { from: "2026-12-03", to: "", note: "" }, NOW, "content"));
    expect(await content({ date: "2026-12-03", startMinute: h(13) })).toMatchObject({ ok: false, code: "slot_taken" });
    expectOk(await photoSession({ date: "2026-12-03", startMinute: h(13) }));
    // Staff set the content creator's times once the owners let them, as the photographer's.
    expect(await savePhotographerHours(world.db, sam, 4, null, "content")).toBe(false);
    await world.db.insert(settings).values({ key: "staffSetsPhotographerTimes", value: true });
    expect(await savePhotographerHours(world.db, sam, 4, null, "content")).toBe(true);
    // The month and the day know whose day it is.
    const catalog = await loadCatalog(world.db);
    const day = await loadDayAvailability(world.db, catalog, DAY, NOW, { withPhotographer: "content" });
    expect(day.photographer).toMatchObject({ openMinute: h(13), closeMinute: h(17) });
    const month = await loadMonthFits(world.db, catalog, { month: "2026-12", studioIds: [world.ids.paris], durationMinutes: 60, photography: true, service: "content" }, NOW);
    expect(month.ok && month.days["2026-12-03"]).toBe(false); // the day off
    expect(month.ok && month.days["2026-12-09"]).toBe(true);
    expect(month.ok && month.days["2026-12-10"]).toBe(false); // Thursdays off now
  });

  it("takes the codes for sessions, refuses those for rentals, and gives a reschedule code for sessions", async () => {
    expectOk(await onSale());
    const forSessions = expectOk(await createManualCode(world.db, { kind: "percent", value: 20, photographyOnly: true, email: null, validDays: 30, maxUses: 5, note: "" }, NOW));
    const forRentals = expectOk(await createManualCode(world.db, { kind: "percent", value: 20, photographyOnly: false, email: null, validDays: 30, maxUses: 5, note: "" }, NOW));
    const input = { studioIds: [world.ids.paris], date: DAY, durationMinutes: 60, photography: true, service: "content", email: "jane@example.com" };
    expect(await quoteSelection(world.db, { ...input, promoCode: forRentals.code }, NOW)).toMatchObject({ ok: false, message: PROMO_MISFIT_TEXT.content });
    expect(PROMO_MISFIT_TEXT.content).toBe("That code is for studio rentals. It cannot be used for a content creation session.");
    const booked = expectOk(await content({ promoCode: forSessions.code }));
    expect(booked.totalCents).toBe(12000);

    // Moved for a code: a credit for sessions, and its link leads to content creation's booking page.
    const credit = expectOk(await requestRescheduleCode(world.db, booked.ref, byToken(booked.manageToken), world.manageDeps()));
    expect(credit.bookPath).toBe("/book/content");
    expectOk(await content({ startMinute: h(14), promoCode: credit.code }));
  });

  it("is moved with its own person, and waited for on the waitlist", async () => {
    expectOk(await onSale());
    const first = expectOk(await content({ startMinute: h(10) }));
    // The content creator is taken at 3 PM by another session; a move there is refused, at 1 PM it is not.
    expectOk(await content({ startMinute: h(15), customer: { name: "Bob Brown", email: "bob@example.com", phone: "407-555-0101" } }));
    expect(await moveBooking(world.db, owner, first.ref, { date: DAY, startMinute: h(15), countsAsClientMove: false }, NOW)).toMatchObject({ ok: false, message: expect.stringMatching(/content creator is not free|not free in the studio/) });
    expectOk(await moveBooking(world.db, owner, first.ref, { date: DAY, startMinute: h(13), countsAsClientMove: false }, NOW));

    const catalog = await loadCatalog(world.db);
    const waiting = await joinWaitlist(
      world.db,
      catalog,
      { studioIds: [world.ids.paris], photography: true, service: "content", durationMinutes: 60, date: DAY, fromMinute: h(13), toMinute: h(14), firstName: "Wren", lastName: "Wait", email: "wren@example.com" },
      NOW,
    );
    expect(waiting.ok).toBe(true);
  });
});

describe("content creation's notice in business days", () => {
  it("counts Monday to Friday from the day after", async () => {
    const { afterBusinessDays, businessDaysInWords } = await import("@/lib/domain/availability");
    expect(afterBusinessDays("2026-11-23", 3)).toBe("2026-11-26"); // Monday → Thursday
    expect(afterBusinessDays("2026-11-27", 3)).toBe("2026-12-02"); // Friday → Wednesday
    expect(afterBusinessDays("2026-11-28", 3)).toBe("2026-12-02"); // Saturday → Wednesday
    expect(afterBusinessDays("2026-11-29", 3)).toBe("2026-12-02"); // Sunday → Wednesday
    expect(afterBusinessDays("2026-11-25", 1)).toBe("2026-11-26");
    expect(afterBusinessDays("2026-11-25", 0)).toBe("2026-11-25");
    expect(businessDaysInWords(3)).toBe("3 business days");
    expect(businessDaysInWords(1)).toBe("1 business day");
  });
});
