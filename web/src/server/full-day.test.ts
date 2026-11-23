import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { combinedStarts } from "@/lib/domain/availability";
import { appointmentLook, calendarColumns, deeper, lanesOf } from "@/lib/domain/appointment-look";
import { saveAddon } from "./admin";
import { moveBooking } from "./appointments";
import type { AuthUser } from "./auth";
import { loadDayAvailability } from "./availability";
import { createBlocks } from "./blocked-time";
import { loadCalendar, type CalendarAppointment } from "./calendar";
import { loadCatalog, type Catalog } from "./catalog";
import { ownerCancelBooking } from "./manage";
import { loadMonthFits } from "./month-availability";
import { propsFree } from "./props";
import { createTestWorld, expectOk, h, NOW, type TestWorld } from "./testing";
import { localToUtc } from "./tz";
import { joinWaitlist, noticeWaitlist } from "./waitlist";

/**
 * The owner's admin brief of 2026-11-22, item 13: a day on which all three studios are booked from opening to closing,
 * with bundles of two and of three studios, a photography session, a prop there is one of, a closure of every studio
 * the next day, a move and a cancellation. Each rule is tested on its own elsewhere; here they meet on one day.
 */

/** A Wednesday 18 days after NOW, outside the two weeks' notice a photography session needs. Open 9 AM to 7 PM. */
const DAY = "2026-12-02";
const THURSDAY = "2026-12-03";
const FRIDAY = "2026-12-04";

describe("a fully booked day (the owner's admin brief of 2026-11-22, item 13)", () => {
  let world: TestWorld;
  let owner: AuthUser;
  beforeAll(async () => {
    world = await createTestWorld();
  });
  afterAll(() => world.close());
  beforeEach(async () => {
    await world.reset();
    owner = await world.addUser("owner@studio.test", "owner");
  });

  const client = (name: string) => ({ name, email: `${name.split(" ")[0].toLowerCase()}@example.com`, phone: "407-555-0150" });
  const book = (name: string, studios: string[], startHours: number, hours: number, more: Parameters<TestWorld["book"]>[0] = {}) =>
    world.book({ studioIds: studios.map((slug) => world.ids[slug]), date: DAY, startMinute: h(startHours), durationMinutes: h(hours), customer: client(name), ...more });

  /** One-hour starts in these studios together on a day, as the booking page offers them. */
  async function hourStarts(catalog: Catalog, date: string, slugs: string[], photography = false): Promise<number[]> {
    const day = await loadDayAvailability(world.db, catalog, date, NOW, { withPhotographer: photography });
    const held = slugs.map((slug) => day.days.find((studio) => studio.studioId === world.ids[slug])!);
    if (photography) held.push(day.photographer!);
    return combinedStarts(held, { durationMinutes: 60, incrementMinutes: catalog.settings.slotIncrementMinutes, earliestStartMinute: day.earliestStartMinute });
  }

  /** Whether the month calendar offers `date` for an hour in these studios. */
  async function offered(catalog: Catalog, date: string, slugs: string[], photography = false): Promise<boolean> {
    const month = await loadMonthFits(world.db, catalog, { month: date.slice(0, 7), studioIds: slugs.map((slug) => world.ids[slug]), durationMinutes: 60, photography }, NOW);
    if (!month.ok) throw new Error(month.message);
    return month.days[date];
  }

  /**
   * Blanche:  Ada 9–11 (all three) · Bea 11:15–1:15 (photography) · Dee 1:30–3:30 (the angel wings) · Gus 3:45–6:45
   * Paris:    Ada 9–11             · Cy 11:15–2:15 (Paris + Dayglow) · Eve 2:30–4:30 · Hal 4:45–6:45
   * Dayglow:  Ada 9–11             · Cy 11:15–2:15                   · Fay 2:30–6:30
   * Each keeps its studio's 15 minutes after it, so no hour is free anywhere from 9 AM to 7 PM.
   */
  async function fillTheDay() {
    const wings = expectOk(await saveAddon(world.db, null, { name: "Angel wings", description: "", priceCents: 4000, kind: "other", studioId: null, stock: 1 })).id;
    const withWings = [{ addonId: wings, quantity: 1 }];
    const ada = expectOk(await book("Ada Ames", ["blanche", "paris", "dayglow"], 9, 2));
    const bea = expectOk(await book("Bea Bell", ["blanche"], 11.25, 2, { photography: true }));
    const cy = expectOk(await book("Cy Cole", ["paris", "dayglow"], 11.25, 3));
    const dee = expectOk(await book("Dee Dunn", ["blanche"], 13.5, 2, { addons: withWings }));
    // The wings are on Dee's set until 3:30: Eve cannot have them at 2:30, and books without them.
    expect(await book("Eve Eng", ["paris"], 14.5, 2, { addons: withWings })).toMatchObject({ ok: false, code: "prop_taken" });
    const eve = expectOk(await book("Eve Eng", ["paris"], 14.5, 2));
    const fay = expectOk(await book("Fay Fox", ["dayglow"], 14.5, 4));
    const gus = expectOk(await book("Gus Gray", ["blanche"], 15.75, 3));
    const hal = expectOk(await book("Hal Hunt", ["paris"], 16.75, 2));
    return { wings, ada, bea, cy, dee, eve, fay, gus, hal };
  }

  it("books every hour of all three studios once, and offers no more of that day", async () => {
    const { ada, bea, cy, dee, eve, fay, gus, hal } = await fillTheDay();
    const catalog = await loadCatalog(world.db);

    // Nothing more fits: not a studio, not a bundle, not a session, on the booking page or in its month calendar.
    for (const slugs of [["blanche"], ["paris"], ["dayglow"], ["paris", "dayglow"], ["paris", "blanche"], ["blanche", "paris", "dayglow"]]) {
      expect(await hourStarts(catalog, DAY, slugs)).toEqual([]);
      expect(await offered(catalog, DAY, slugs)).toBe(false);
      expect(await offered(catalog, "2026-12-01", slugs)).toBe(true); // the day before is open
    }
    expect(await offered(catalog, DAY, ["dayglow"], true)).toBe(false);
    // The photographer is held for Bea's session, with the same 15 minutes after it.
    const day = await loadDayAvailability(world.db, catalog, DAY, NOW, { withPhotographer: true });
    expect(day.photographer!.busy).toContainEqual(expect.objectContaining({ start: h(11.25), end: h(13.5) }));

    // And no double booking, whichever way it is tried.
    expect(await book("Ivy Ivers", ["paris"], 12, 1)).toMatchObject({ ok: false, code: "slot_taken" });
    expect(await book("Ivy Ivers", ["paris", "blanche"], 9, 1)).toMatchObject({ ok: false, code: "slot_taken" });
    expect(await book("Ivy Ivers", ["dayglow"], 12, 1, { photography: true })).toMatchObject({ ok: false, code: "slot_taken" });
    expect(await book("Ivy Ivers", ["blanche"], 18, 1)).toMatchObject({ ok: false, code: "slot_taken" }); // Gus until 6:45

    // The calendar: eight appointments, each once, a bundle holding all its studios, none over another in a studio.
    const calendar = await loadCalendar(world.db, owner, catalog, { from: DAY, to: THURSDAY });
    const refs = { ada, bea, cy, dee, eve, fay, gus, hal };
    expect(calendar.appointments.map((appointment) => appointment.ref).sort()).toEqual(Object.values(refs).map((booked) => booked.ref).sort());
    const byRef = (ref: string) => calendar.appointments.find((appointment) => appointment.ref === ref)!;
    expect(byRef(ada.ref).studioIds.sort()).toEqual([world.ids.blanche, world.ids.dayglow, world.ids.paris].sort());
    for (const studio of catalog.studios) {
      const own = calendar.appointments.filter((appointment) => appointment.studioIds.includes(studio.id)).sort((a, b) => a.startMinute - b.startMinute);
      own.slice(1).forEach((appointment, index) => expect(appointment.startMinute).toBeGreaterThanOrEqual(own[index].endMinute + studio.bufferMinutes));
      expect(own[0].startMinute).toBe(h(9));
    }

    // Drawn in columns Blanche, Paris, Dayglow: each bundle is one block across its studios side by side, in its colour.
    const columns = calendarColumns(catalog.studios);
    expect(columns.map((studio) => studio.slug)).toEqual(["blanche", "paris", "dayglow"]);
    const held = (appointment: CalendarAppointment) => catalog.studios.filter((studio) => appointment.studioIds.includes(studio.id));
    expect(lanesOf(byRef(ada.ref).studioIds, columns)).toEqual([{ lane: 0, span: 3 }]);
    expect(lanesOf(byRef(cy.ref).studioIds, columns)).toEqual([{ lane: 1, span: 2 }]);
    expect(appointmentLook(held(byRef(ada.ref)), false)).toEqual({ name: "Paris + Dayglow + Blanche", color: "#a88524", bundle: true });
    expect(appointmentLook(held(byRef(cy.ref)), false)).toEqual({ name: "Paris + Dayglow", color: "#c63f76", bundle: true });
    const blanche = catalog.studios.find((studio) => studio.slug === "blanche")!;
    expect(byRef(bea.ref).photography).toBe(true);
    expect(appointmentLook(held(byRef(bea.ref)), true).color).toBe(deeper(blanche.color));
    expect(appointmentLook(held(byRef(dee.ref)), false).color).toBe(blanche.color);
    expect(appointmentLook(held(byRef(gus.ref)), false).color).toBe(blanche.color);
  });

  it("closes the next day, refuses to close the full one, moves a booking and frees a cancelled one's time for the waitlist", async () => {
    const { wings, ada, cy, fay, hal } = await fillTheDay();
    const catalog = await loadCatalog(world.db);
    const everyStudio = [world.ids.blanche, world.ids.paris, world.ids.dayglow];
    const closure = { studioIds: everyStudio, wholeDay: true, startMinute: 0, endMinute: 0, weekdays: [], reason: "private_event", note: "" };

    // The full day cannot be closed: the refusal names each appointment once, a bundle with all its studios.
    const refused = await createBlocks(world.db, { ...closure, from: DAY, to: DAY }, NOW);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.conflicts.map((conflict) => conflict.customerName)).toEqual(["Ada Ames", "Bea Bell", "Cy Cole", "Dee Dunn", "Fay Fox", "Eve Eng", "Gus Gray", "Hal Hunt"]);
    expect(refused.conflicts[0]).toMatchObject({ ref: ada.ref, studio: "Studio Blanche + Studio Dayglow + Studio Paris", time: "9:00 AM – 11:00 AM" });
    expect(refused.conflicts[2]).toMatchObject({ ref: cy.ref, studio: "Studio Dayglow + Studio Paris" });
    expect(refused.message).toMatch(/^Nothing was blocked\. 8 appointments hold part of that time: .*, and 3 more\. Move or cancel the appointments first, or leave that time out\.$/);

    // Thursday is closed for a private event: nothing is offered on it, Friday is open.
    expect(await createBlocks(world.db, { ...closure, from: THURSDAY, to: THURSDAY }, NOW)).toMatchObject({ ok: true, days: 1 });
    expect([await offered(catalog, THURSDAY, ["paris"]), await offered(catalog, FRIDAY, ["paris"])]).toEqual([false, true]);

    // Hal's two hours cannot move into the closure; they move to Friday, and Paris is free after Eve again.
    expect(await moveBooking(world.db, owner, hal.ref, { date: THURSDAY, startMinute: h(16.75), countsAsClientMove: false }, NOW)).toMatchObject({ ok: false, reason: "slot_taken" });
    expectOk(await moveBooking(world.db, owner, hal.ref, { date: FRIDAY, startMinute: h(16.75), countsAsClientMove: false }, NOW));
    expect(await hourStarts(catalog, DAY, ["paris"])).toEqual([h(16.75), h(17), h(17.25), h(17.5), h(17.75), h(18)]);
    const friday = await loadCalendar(world.db, owner, catalog, { from: FRIDAY, to: "2026-12-05" });
    expect(friday.appointments.map((appointment) => [appointment.ref, appointment.startMinute])).toEqual([[hal.ref, h(16.75)]]);

    // A client waits for two hours in Dayglow in the afternoon. Fay's four hours are cancelled: the client is emailed once.
    const waiting = { studioIds: [world.ids.dayglow], photography: false, durationMinutes: 120, date: DAY, fromMinute: h(15), toMinute: h(17), firstName: "Wren", lastName: "Waits", email: "wren@example.com" };
    expectOk(await joinWaitlist(world.db, catalog, waiting, NOW));
    const notice = () => noticeWaitlist(world.db, catalog, { now: NOW, baseUrl: "https://studio.test" });
    expect(await notice()).toBe(0);
    expectOk(await ownerCancelBooking(world.db, fay.ref, { refundCents: 0 }, world.manageDeps()));
    expect(await notice()).toBe(1);
    expect((await world.emails("waitlist_opening")).map((mail) => mail.toEmail)).toEqual(["wren@example.com"]);
    expect(await hourStarts(catalog, DAY, ["dayglow"])).toEqual(Array.from({ length: 15 }, (_, index) => h(14.5) + index * 15));

    // Two clients press for the same freed hour at once: one has it, the other is told it is taken.
    const both = await Promise.all([book("Jo Jones", ["dayglow"], 14.5, 1), book("Kit Kerr", ["dayglow"], 14.5, 1)]);
    expect(both.filter((result) => result.ok)).toHaveLength(1);
    expect(both.find((result) => !result.ok)).toMatchObject({ code: "slot_taken" });

    // The wings come back from Dee's set at 3:30, and go with the next booking that asks for them.
    expectOk(await book("Lou Lane", ["dayglow"], 15.75, 1, { addons: [{ addonId: wings, quantity: 1 }] }));
    expect(await propsFree(world.db, localToUtc(DAY, h(15.75)), localToUtc(DAY, h(16.75)))).toEqual({ [wings]: 0 });

    // Every email of the day went to a test address: the clients' at example.com, the owners' at studio.test.
    expect((await world.emails()).every((mail) => /@(example\.com|studio\.test)$/.test(mail.toEmail))).toBe(true);
  });
});
