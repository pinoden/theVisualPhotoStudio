import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { addons, bookingAddons, bookings, settings, staffShifts, studioHolds } from "@/db/schema";
import { createAdminBooking, getAppointment, moveBooking, moveOptions, setLabel } from "./appointments";
import type { AuthUser } from "./auth";
import { loadCalendar } from "./calendar";
import { loadCatalog } from "./catalog";
import { cancelBooking, getManageChoices, getManageOptions } from "./manage";
import { getDaySheet } from "./staff";
import { completeVisits } from "./tasks";
import { DEFAULT_SETTINGS } from "./settings";
import { termsAtBooking } from "./terms";
import { BASE_URL, createTestWorld, expectOk, h, hoursAfter, NEAR, NOW, type TestWorld } from "./testing";

let world: TestWorld;
let owner: AuthUser;
let sam: AuthUser; // staff, assigned to NEAR
let riley: AuthUser; // staff, assigned to nothing
let jane: AuthUser; // a customer
let morningRef: string; // Bob, Dayglow, 9:00 to 10:00 on NEAR
let nextDayRef: string; // Jane, Blanche, 10:00 to 12:00 the day after
/** The booking as if it had been made under these terms (question 10: a booking keeps the terms it was made under). */
const madeUnder = (ref: string, changes: Partial<ReturnType<typeof termsAtBooking>>) =>
  world.db.update(bookings).set({ terms: { ...termsAtBooking(DEFAULT_SETTINGS, false), ...changes } }).where(eq(bookings.ref, ref));

const NEXT_DAY = "2026-11-19";
const START = new Date("2026-11-18T14:00:00Z"); // 9:00 studio time
const during = hoursAfter(START, 0.5);

beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());

beforeEach(async () => {
  await world.reset();
  owner = await world.addUser("owner@studio.test", "owner", "Olivia");
  sam = await world.addUser("sam@studio.test", "staff", "Sam");
  riley = await world.addUser("riley@studio.test", "staff", "Riley");
  jane = await world.addUser("jane@example.com", "customer", "Jane");
  await world.db.insert(staffShifts).values({ userId: sam.id, day: NEAR });
  morningRef = expectOk(
    await world.book({
      studioIds: [world.ids.dayglow],
      startMinute: h(9),
      durationMinutes: 60,
      notes: "Bringing a dog",
      customer: { name: "Bob Brown", email: "bob@example.com", phone: "407-555-0111" },
    }),
  ).ref;
  nextDayRef = expectOk(await world.book({ date: NEXT_DAY })).ref;
});

const row = async (ref: string) => (await world.db.select().from(bookings).where(eq(bookings.ref, ref)))[0];
const allow = (key: string, value = true) =>
  world.db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });

describe("status labels", () => {
  it("lets staff set every label, each from the moment it makes sense", async () => {
    // Days ahead: the client asks to move. The booking stays confirmed.
    expect(await setLabel(world.db, sam, morningRef, "reschedule_pending", NOW)).toEqual({ ok: true, label: "reschedule_pending" });
    expect(await row(morningRef)).toMatchObject({ status: "confirmed", label: "reschedule_pending" });
    expect(await setLabel(world.db, sam, morningRef, "rescheduled", NOW)).toEqual({ ok: true, label: "rescheduled" });

    // Checked In opens an hour before the start; Completed and No Show at the start.
    expect(await setLabel(world.db, sam, morningRef, "checked_in", hoursAfter(START, -2))).toEqual({ ok: false, reason: "too_early" });
    expect(await setLabel(world.db, sam, morningRef, "no_show", hoursAfter(START, -0.5))).toEqual({ ok: false, reason: "too_early" });
    expect(await setLabel(world.db, sam, morningRef, "checked_in", hoursAfter(START, -0.5))).toEqual({ ok: true, label: "checked_in" });
    expect(await row(morningRef)).toMatchObject({ status: "confirmed", label: "checked_in" });

    expect(await setLabel(world.db, sam, morningRef, "no_show", during)).toEqual({ ok: true, label: "no_show" });
    expect(await row(morningRef)).toMatchObject({ status: "no_show", label: null });
    expect(await setLabel(world.db, sam, morningRef, "completed", during)).toEqual({ ok: true, label: "completed" }); // a correction
    expect(await row(morningRef)).toMatchObject({ status: "completed", label: null });

    expect(await setLabel(world.db, sam, morningRef, "completed", during)).toEqual({ ok: false, reason: "unchanged" });
    expect(await setLabel(world.db, sam, morningRef, "confirmed", during)).toEqual({ ok: true, label: "confirmed" });
    expect(await row(morningRef)).toMatchObject({ status: "confirmed", label: null });
  });

  it("keeps a history of every change, with the time and who made it", async () => {
    await setLabel(world.db, sam, morningRef, "reschedule_pending", NOW);
    await setLabel(world.db, owner, morningRef, "confirmed", hoursAfter(NOW, 1));
    await setLabel(world.db, sam, morningRef, "checked_in", hoursAfter(START, -0.25));
    await setLabel(world.db, sam, morningRef, "checked_in", during); // refused: nothing to record

    const appointment = (await getAppointment(world.db, owner, morningRef, during))!;
    expect(appointment.history).toEqual([
      { at: NOW.toISOString(), from: "new", to: "confirmed", actor: "customer", note: "Booked online" },
      { at: NOW.toISOString(), from: "confirmed", to: "reschedule_pending", actor: "sam@studio.test", note: "" },
      { at: hoursAfter(NOW, 1).toISOString(), from: "reschedule_pending", to: "confirmed", actor: "owner@studio.test", note: "" },
      { at: hoursAfter(START, -0.25).toISOString(), from: "confirmed", to: "checked_in", actor: "sam@studio.test", note: "" },
    ]);
    expect(appointment.label).toBe("checked_in");
  });

  it("records a cancellation and a completion by the site in the same history", async () => {
    await cancelBooking(world.db, nextDayRef, { kind: "owner" }, world.manageDeps());
    expect((await getAppointment(world.db, owner, nextDayRef, NOW))!.history.at(-1)).toMatchObject({
      from: "confirmed",
      to: "cancelled",
      actor: "the studio",
    });

    await setLabel(world.db, sam, morningRef, "checked_in", during);
    const evening = hoursAfter(START, 12);
    await completeVisits(world.db, evening, BASE_URL);
    expect(await row(morningRef)).toMatchObject({ status: "completed", label: null });
    expect((await getAppointment(world.db, owner, morningRef, evening))!.history.at(-1)).toEqual({
      at: evening.toISOString(),
      from: "checked_in",
      to: "completed",
      actor: "system",
      note: "",
    });
  });

  it("refuses bookings on days a member of staff may not see, without revealing whether they exist", async () => {
    const later = hoursAfter(NOW, 24 * 10);
    expect(await setLabel(world.db, sam, nextDayRef, "no_show", later)).toEqual({ ok: false, reason: "forbidden" });
    expect(await setLabel(world.db, sam, "VS-AAAAAA", "no_show", later)).toEqual({ ok: false, reason: "forbidden" });
    expect(await setLabel(world.db, riley, morningRef, "no_show", later)).toEqual({ ok: false, reason: "forbidden" });
    expect(await setLabel(world.db, jane, nextDayRef, "completed", later)).toEqual({ ok: false, reason: "forbidden" });
    expect(await row(nextDayRef)).toMatchObject({ status: "confirmed", label: null });
    expect(await row(morningRef)).toMatchObject({ status: "confirmed", label: null });
  });

  it("lets the owners label a booking on any day, but not a cancelled one", async () => {
    const later = hoursAfter(NOW, 24 * 10);
    expect(await setLabel(world.db, owner, nextDayRef, "no_show", later)).toEqual({ ok: true, label: "no_show" });
    await cancelBooking(world.db, morningRef, { kind: "owner" }, world.manageDeps());
    expect(await setLabel(world.db, owner, morningRef, "completed", later)).toEqual({ ok: false, reason: "not_active" });
    expect(await setLabel(world.db, owner, "VS-AAAAAA", "completed", later)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("Reschedule Pending", () => {
  it("keeps the appointment's details and does not free its time slot", async () => {
    const before = await row(morningRef);
    await setLabel(world.db, sam, morningRef, "reschedule_pending", NOW);

    const after = await row(morningRef);
    expect(after).toMatchObject({ startAt: before.startAt, endAt: before.endAt, customerName: "Bob Brown", notes: "Bringing a dog", totalCents: before.totalCents });
    const holds = await world.db.select().from(studioHolds).where(eq(studioHolds.bookingId, before.id));
    expect(holds.map((hold) => hold.active)).toEqual([true]);
    // Nobody else can take the time while it is pending.
    expect(await world.book({ studioIds: [world.ids.dayglow], startMinute: h(9), durationMinutes: 60 })).toMatchObject({
      ok: false,
      code: "slot_taken",
    });
  });

  it("is left alone by the scheduled task, which completes the other visits of the day", async () => {
    const other = expectOk(await world.book({ startMinute: h(14), durationMinutes: 60 }));
    await setLabel(world.db, sam, morningRef, "reschedule_pending", NOW);

    expect(await completeVisits(world.db, hoursAfter(START, 12), BASE_URL)).toMatchObject({ completed: 1 });
    expect(await row(other.ref)).toMatchObject({ status: "completed" });
    expect(await row(morningRef)).toMatchObject({ status: "confirmed", label: "reschedule_pending" });
  });
});

describe("the two levels of the admin", () => {
  it("gives the owners everything about an appointment", async () => {
    const appointment = (await getAppointment(world.db, owner, morningRef, NOW))!;
    expect(appointment).toMatchObject({
      ref: morningRef,
      label: "confirmed",
      studios: ["Studio Dayglow"],
      customerName: "Bob Brown",
      customerPhone: "407-555-0111",
      customerEmail: "bob@example.com",
      notes: "Bringing a dog",
      may: { setLabels: true, move: true },
    });
    expect(appointment.money).toMatchObject({ totalCents: 7800 });
    expect(appointment.labelChoices.map((choice) => [choice.key, choice.allowed])).toEqual([
      ["confirmed", false], // it has no label to take off
      ["checked_in", false], // four days too early
      ["completed", false],
      ["rescheduled", true],
      ["no_show", false],
      ["reschedule_pending", true],
    ]);
  });

  it("gives staff the appointment with contact details and without prices, and lets them change its label", async () => {
    const appointment = (await getAppointment(world.db, sam, morningRef, NOW))!;
    expect(appointment).toMatchObject({
      customerName: "Bob Brown",
      customerPhone: "407-555-0111", // shown by default since the owner's answer of 2026-11-15
      customerEmail: "bob@example.com",
      money: null,
      may: { setLabels: true, move: false },
    });
    expect(JSON.stringify(appointment)).not.toContain("7800");

    await allow("staffSeesContact", false);
    const hidden = (await getAppointment(world.db, sam, morningRef, NOW))!;
    expect(hidden).toMatchObject({ customerPhone: null, customerEmail: null });
    expect(JSON.stringify(hidden)).not.toContain("bob@example.com");
  });

  it("follows the owners' switches at once, with nothing redeployed", async () => {
    await allow("staffSeesPrices");
    await allow("staffMovesBookings");
    expect(await getAppointment(world.db, sam, morningRef, NOW)).toMatchObject({
      customerPhone: "407-555-0111",
      customerEmail: "bob@example.com",
      money: { totalCents: 7800 },
      may: { setLabels: true, move: true },
    });

    await allow("staffSetsLabels", false);
    expect((await getAppointment(world.db, sam, morningRef, NOW))!.may.setLabels).toBe(false);
    expect(await setLabel(world.db, sam, morningRef, "reschedule_pending", NOW)).toEqual({ ok: false, reason: "forbidden" });
    // The owners are not bound by the switches.
    expect(await setLabel(world.db, owner, morningRef, "reschedule_pending", NOW)).toMatchObject({ ok: true });

    await allow("staffSetsLabels");
    await allow("staffSeesAllDays");
    expect(await setLabel(world.db, sam, nextDayRef, "rescheduled", NOW)).toEqual({ ok: true, label: "rescheduled" });
    expect(await getDaySheet(world.db, riley, NEXT_DAY)).toMatchObject({ ok: true });
  });

  it("shows nothing for a day that is not theirs, to a customer, or for something that is not an appointment", async () => {
    expect(await getAppointment(world.db, sam, nextDayRef, NOW)).toBeNull();
    expect(await getAppointment(world.db, riley, morningRef, NOW)).toBeNull();
    expect(await getAppointment(world.db, jane, nextDayRef, NOW)).toBeNull(); // her own booking: this page is not hers
    expect(await getAppointment(world.db, owner, "VS-AAAAAA", NOW)).toBeNull();
    expect(await getAppointment(world.db, owner, "not-a-reference", NOW)).toBeNull();

    await world.db.update(bookings).set({ status: "expired" }).where(eq(bookings.ref, nextDayRef));
    expect(await getAppointment(world.db, owner, nextDayRef, NOW)).toBeNull(); // an abandoned checkout
  });
});

describe("moving a booking to a new time", () => {
  const to = (startMinute: number, date = NEAR, countsAsClientMove = false) => ({ date, startMinute, countsAsClientMove });
  const holdOf = async (ref: string) => {
    const booking = await row(ref);
    const [hold] = await world.db
      .select({ from: sql<Date>`lower(${studioHolds.occupied})`, to: sql<Date>`upper(${studioHolds.occupied})`, active: studioHolds.active })
      .from(studioHolds)
      .where(eq(studioHolds.bookingId, booking.id));
    return { from: new Date(hold.from).toISOString(), to: new Date(hold.to).toISOString(), active: hold.active };
  };

  it("is the owners' to do, and staff's only once the owners switch it on", async () => {
    expect(await moveBooking(world.db, sam, morningRef, to(h(11)), NOW)).toMatchObject({ ok: false, reason: "forbidden" });
    expect(await moveOptions(world.db, sam, morningRef, NEAR, NOW)).toMatchObject({ ok: false });
    await allow("staffMovesBookings");
    expect(await moveBooking(world.db, sam, morningRef, to(h(11)), NOW)).toMatchObject({ ok: true });
    // Still only on the days they may see.
    expect(await moveBooking(world.db, sam, nextDayRef, to(h(15), NEXT_DAY), NOW)).toMatchObject({ ok: false, reason: "forbidden" });
    expect(await moveBooking(world.db, jane, nextDayRef, to(h(15), NEXT_DAY), NOW)).toMatchObject({ ok: false, reason: "forbidden" });
  });

  it("changes the time, keeps the studio held for the new time and the gap after it, and tells the customer", async () => {
    const before = await row(morningRef);
    const moved = await moveBooking(world.db, owner, morningRef, to(h(13) + 15, NEXT_DAY), NOW);
    expect(moved).toMatchObject({ ok: true });

    const after = await row(morningRef);
    expect(after.startAt.toISOString()).toBe("2026-11-19T18:15:00.000Z"); // 1:15 PM studio time
    expect(after.endAt.toISOString()).toBe("2026-11-19T19:15:00.000Z");
    expect(after).toMatchObject({ status: "confirmed", label: "rescheduled", totalCents: before.totalCents, rescheduledCount: 0 });
    expect(await holdOf(morningRef)).toEqual({ from: "2026-11-19T18:15:00.000Z", to: "2026-11-19T19:30:00.000Z", active: true });

    // The old time is free again, and the new one is taken.
    expect((await world.book({ studioIds: [world.ids.dayglow], startMinute: h(9), durationMinutes: 60 })).ok).toBe(true);
    expect(await world.book({ studioIds: [world.ids.dayglow], date: NEXT_DAY, startMinute: h(13), durationMinutes: 60 })).toMatchObject({ code: "slot_taken" });

    const history = (await getAppointment(world.db, owner, morningRef, NOW))!.history;
    expect(history.at(-1)).toMatchObject({ from: "confirmed", to: "rescheduled", actor: "owner@studio.test" });
    expect(history.at(-1)!.note).toMatch(/^Moved from .*Nov 18.* to .*Nov 19/);
    const [mail] = await world.emails("booking_moved");
    expect(mail).toMatchObject({ toEmail: "bob@example.com", subject: `Your booking ${morningRef} has a new time` });
    expect(mail.body).toContain("New time: ");
  });

  it("obeys the rules every booking obeys: opening hours, no overlap, and 15 minutes between appointments", async () => {
    const other = expectOk(await world.book({ studioIds: [world.ids.dayglow], startMinute: h(14), durationMinutes: 60 })); // 2:00 to 3:00
    expect(other.ok).toBe(true);

    expect(await moveBooking(world.db, owner, morningRef, to(h(14) + 30), NOW)).toMatchObject({ ok: false, reason: "slot_taken" }); // overlaps
    expect(await moveBooking(world.db, owner, morningRef, to(h(13)), NOW)).toMatchObject({ ok: false, reason: "slot_taken" }); // ends as the next begins
    expect(await moveBooking(world.db, owner, morningRef, to(h(15)), NOW)).toMatchObject({ ok: false, reason: "slot_taken" }); // begins as the last ends
    expect(await moveBooking(world.db, owner, morningRef, to(h(8)), NOW)).toMatchObject({ ok: false, reason: "slot_taken" }); // before opening
    expect(await moveBooking(world.db, owner, morningRef, to(h(9) + 10), NOW)).toMatchObject({ ok: false, reason: "slot_taken" }); // not a start time
    expect(await moveBooking(world.db, owner, morningRef, to(h(9)), NOW)).toMatchObject({ ok: false, reason: "invalid_time" }); // where it already is
    expect(await moveBooking(world.db, owner, morningRef, to(h(9), "2026-11-10"), NOW)).toMatchObject({ ok: false, reason: "invalid_time" }); // the past

    // Its own present time does not stand in its way: a quarter of an hour later is fine.
    expect(await moveBooking(world.db, owner, morningRef, to(h(9) + 15), NOW)).toMatchObject({ ok: true });
    expect(await moveBooking(world.db, owner, morningRef, to(h(12) + 45), NOW)).toMatchObject({ ok: true }); // exactly 15 minutes before the next
    // Other studios have calendars of their own: Paris at the time Dayglow is taken.
    expect((await world.book({ studioIds: [world.ids.paris], startMinute: h(14), durationMinutes: 60 })).ok).toBe(true);
  });

  it("lets the studio move a Blanche and Dayglow booking made before the bundle rule", async () => {
    const booking = await row(morningRef);
    // An existing Dayglow booking also held Blanche under the previous rules.
    await world.db.execute(sql`
      insert into studio_holds (studio_id, occupied, booking_id)
      select ${world.ids.blanche}, occupied, booking_id from studio_holds where booking_id = ${booking.id}
    `);

    const options = expectOk(await moveOptions(world.db, owner, morningRef, NEXT_DAY, NOW));
    expect(options.starts).toContain(h(14));
    expect(await moveBooking(world.db, owner, morningRef, to(h(14), NEXT_DAY), NOW)).toMatchObject({ ok: true });
    const holds = await world.db.select().from(studioHolds).where(eq(studioHolds.bookingId, booking.id));
    expect(holds.map((hold) => hold.studioId)).toEqual(expect.arrayContaining([world.ids.blanche, world.ids.dayglow]));
  });

  it("offers only the start times that are free for this booking", async () => {
    expectOk(await world.book({ studioIds: [world.ids.dayglow], startMinute: h(14), durationMinutes: 60 }));
    const options = await moveOptions(world.db, owner, morningRef, NEAR, NOW);
    const starts = options.ok ? options.starts : [];
    expect(starts.slice(0, 3)).toEqual([h(9), h(9) + 15, h(9) + 30]); // its own time is offered: it could stay close by
    expect(starts).toContain(h(12) + 45);
    expect(starts).not.toContain(h(13)); // would touch the 2:00 booking
    expect(starts).not.toContain(h(15)); // inside the gap after it
    expect(starts).toContain(h(15) + 15);
  });

  it("counts as the client's one reschedule when the client asked for it: no automatic refund afterwards", async () => {
    await moveBooking(world.db, owner, nextDayRef, to(h(14), "2026-12-09", true), NOW);
    expect(await row(nextDayRef)).toMatchObject({ rescheduledCount: 1 });
    const options = await getManageOptions(world.db, nextDayRef, { kind: "owner" }, NOW);
    // Moved, not made with a reschedule code: the client is told so, and why.
    expect(options?.cancel).toMatchObject({ allowed: true, refundCents: 0, why: "moved" });
    // It was their free reschedule: moving it again online costs the fee.
    expect(options?.reschedule).toEqual({ allowed: true, creditCents: 15600, discountCents: 0, feeCents: 2000, nextFeeCents: 2000 });
    expect((await getManageChoices(world.db, nextDayRef, { kind: "owner" }, NOW))?.cancel.text).toBe(
      "No refund is due, because this booking was moved at your request: a moved booking is not refunded.",
    );
    const [mail] = await world.emails("booking_moved");
    expect(mail.body).toContain(
      "As you asked for this change, it counts as a reschedule under the rental terms: if the booking is cancelled now, it is not refunded. Moving it again online costs $20.",
    );
  });

  it("says a booking moved for the client cannot be moved again online while the owners set no fee", async () => {
    // Made while the owners set no fee for a further move: a booking keeps the terms it was made under.
    await madeUnder(nextDayRef, { rescheduleFeeCents: 0 });
    await moveBooking(world.db, owner, nextDayRef, to(h(14), "2026-12-09", true), NOW);
    expect((await getManageOptions(world.db, nextDayRef, { kind: "owner" }, NOW))?.reschedule).toEqual({ allowed: false, reason: "limit_reached" });
    const [mail] = await world.emails("booking_moved");
    expect(mail.body).toContain(
      "As you asked for this change, it counts as a reschedule under the rental terms: if the booking is cancelled now, it is not refunded, and it cannot be moved again online.",
    );
  });

  it("does not count against the client while moving is switched off, which the rental terms then do not mention", async () => {
    // Made while moving was switched off.
    await madeUnder(nextDayRef, { maxReschedules: 0 });
    await moveBooking(world.db, owner, nextDayRef, to(h(14), "2026-12-09", true), NOW);
    expect(await row(nextDayRef)).toMatchObject({ rescheduledCount: 0 });
    // Still refunded as the terms say: 7 days or more ahead.
    expect((await getManageOptions(world.db, nextDayRef, { kind: "owner" }, NOW))?.cancel).toMatchObject({ allowed: true, why: "refund" });
    const [mail] = await world.emails("booking_moved");
    expect(mail.body).not.toContain("counts as a reschedule");
  });

  it("is only for a booking that is still to come", async () => {
    await cancelBooking(world.db, morningRef, { kind: "owner" }, world.manageDeps());
    expect(await moveBooking(world.db, owner, morningRef, to(h(11)), NOW)).toMatchObject({ ok: false, reason: "not_movable" });
    expect(await moveBooking(world.db, owner, nextDayRef, to(h(11), "2026-12-09"), hoursAfter(NOW, 24 * 20))).toMatchObject({ ok: false, reason: "not_movable" });
    expect(await moveBooking(world.db, owner, "VS-AAAAAA", to(h(11)), NOW)).toMatchObject({ ok: false, reason: "not_found" });
  });
});

describe("a booking made in the admin for a client", () => {
  const client = { name: "Dana Diaz", email: "dana@example.com", phone: "407-555-0142" };
  const TODAY = "2026-11-14"; // NOW is 10:00 on this Saturday, studio time
  const request = { studioIds: [] as string[], date: TODAY, startMinute: h(14), durationMinutes: 120, customer: client };
  const deps = { now: NOW, baseUrl: BASE_URL };

  it("can be for today, charges nothing online, and sends the client their confirmation", async () => {
    const chargedBefore = world.charges.length;
    const made = expectOk(await createAdminBooking(world.db, owner, { ...request, studioIds: [world.ids.blanche] }, deps));
    expect(world.charges).toHaveLength(chargedBefore); // no card was charged for it
    const booking = await row(made.ref);
    expect(booking).toMatchObject({ status: "confirmed", madeBy: "owner@studio.test", totalCents: 19000, customerEmail: "dana@example.com", termsAcceptedAt: null });

    const mail = (await world.emails("booking_confirmation")).at(-1)!;
    expect(mail.toEmail).toBe("dana@example.com");
    expect(mail.body).toContain("To pay at the studio: $190");
    const appointment = (await getAppointment(world.db, owner, made.ref, NOW))!;
    expect(appointment.history).toEqual([
      { at: NOW.toISOString(), from: "new", to: "confirmed", actor: "owner@studio.test", note: "Booked in the admin for the client" },
    ]);
    expect(appointment.money).toMatchObject({ madeByAdmin: true });

    // A customer cannot book the same afternoon online: they have to give a day's notice.
    expect(await world.book({ studioIds: [world.ids.paris], date: TODAY, startMinute: h(14) })).toMatchObject({ ok: false });
  });

  it("takes the add-ons the client wants, at their price, to be paid at the studio", async () => {
    const offered = await world.db.select().from(addons);
    const people = offered.find((addon) => addon.kind === "people" && addon.studioId === null)!;
    const pet = offered.find((addon) => addon.kind === "pet")!; // for bookings that include Dayglow
    const made = expectOk(
      await createAdminBooking(world.db, owner, { ...request, studioIds: [world.ids.dayglow], addons: [{ addonId: people.id, quantity: 1 }, { addonId: pet.id, quantity: 1 }] }, deps),
    );
    const booking = await row(made.ref);
    expect(booking.addonsCents).toBe(people.priceCents + pet.priceCents);
    expect(booking.totalCents).toBe(16400 + people.priceCents + pet.priceCents);
    const kinds = (await world.db.select().from(bookingAddons).where(eq(bookingAddons.bookingId, booking.id))).map((line) => line.kind).sort();
    expect(kinds).toEqual(["people", "pet"]);
    expect((await world.emails("booking_confirmation")).at(-1)!.body).toContain(`To pay at the studio: $${(16400 + people.priceCents + pet.priceCents) / 100}`);
    // An add-on of another studio is not for this booking.
    expect(await createAdminBooking(world.db, owner, { ...request, studioIds: [world.ids.paris], startMinute: h(17), durationMinutes: 60, addons: [{ addonId: pet.id, quantity: 1 }] }, deps)).toMatchObject({ ok: false });
  });

  it("obeys the same availability rules as a booking made online", async () => {
    expectOk(await createAdminBooking(world.db, owner, { ...request, studioIds: [world.ids.blanche] }, deps)); // 2:00 to 4:00
    const again = (startMinute: number, studio = world.ids.blanche) =>
      createAdminBooking(world.db, owner, { ...request, studioIds: [studio], startMinute, durationMinutes: 60 }, deps);
    expect(await again(h(15))).toMatchObject({ ok: false, code: "slot_taken" }); // overlaps
    expect(await again(h(16))).toMatchObject({ ok: false, code: "slot_taken" }); // no gap after the last
    expect(await again(h(21))).toMatchObject({ ok: false, code: "slot_taken" }); // after closing
    expect(await again(h(9))).toMatchObject({ ok: false, code: "slot_taken" }); // earlier today: already past
    expect(await again(h(16) + 15)).toMatchObject({ ok: true }); // 15 minutes after
    expect(await again(h(15), world.ids.paris)).toMatchObject({ ok: true }); // another studio's calendar
  });

  it("refuses a new Blanche and Dayglow booking without Paris even in the admin", async () => {
    const studioIds = [world.ids.blanche, world.ids.dayglow];
    expect(await createAdminBooking(world.db, owner, { ...request, studioIds }, deps)).toMatchObject({
      ok: false,
      code: "invalid_price",
      message: "To book Blanche and Dayglow together, add Paris or choose a different combination.",
    });
    expect(await createAdminBooking(world.db, owner, { ...request, studioIds: [...studioIds, world.ids.paris] }, deps)).toMatchObject({ ok: true });
  });

  it("is the owners' to do, and staff's only once the owners switch it on", async () => {
    const asked = { ...request, studioIds: [world.ids.blanche] };
    expect(await createAdminBooking(world.db, sam, asked, deps)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await createAdminBooking(world.db, jane, asked, deps)).toMatchObject({ ok: false, code: "forbidden" });
    await allow("staffCreatesBookings");
    expect(await createAdminBooking(world.db, sam, asked, deps)).toMatchObject({ ok: true });
    expect(await createAdminBooking(world.db, jane, { ...asked, startMinute: h(17) }, deps)).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("the calendar's appointments", () => {
  const WEEK = { from: "2026-11-15", to: "2026-11-22" };

  it("shows the owners every appointment of the span, once for each studio it holds", async () => {
    const bundle = expectOk(await world.book({ studioIds: [world.ids.blanche, world.ids.paris], startMinute: h(15), durationMinutes: 60 }));
    const catalog = await loadCatalog(world.db);
    const calendar = await loadCalendar(world.db, owner, catalog, WEEK);

    expect(calendar.days).toHaveLength(7);
    expect(calendar.appointments.map((entry) => [entry.ref, entry.date, entry.startMinute, entry.endMinute, entry.label])).toEqual([
      [morningRef, NEAR, h(9), h(10), "confirmed"],
      [bundle.ref, NEAR, h(15), h(16), "confirmed"],
      [nextDayRef, NEXT_DAY, h(10), h(12), "confirmed"],
    ]);
    expect(calendar.appointments[1].studioIds.sort()).toEqual([world.ids.blanche, world.ids.paris].sort());
    expect(calendar.appointments[0]).toMatchObject({ customerName: "Bob Brown", studioIds: [world.ids.dayglow] });
  });

  it("leaves out cancelled bookings and follows a label as it changes", async () => {
    await cancelBooking(world.db, nextDayRef, { kind: "owner" }, world.manageDeps());
    await setLabel(world.db, owner, morningRef, "reschedule_pending", NOW);
    const calendar = await loadCalendar(world.db, owner, await loadCatalog(world.db), WEEK);
    expect(calendar.appointments.map((entry) => [entry.ref, entry.label])).toEqual([[morningRef, "reschedule_pending"]]);
  });

  it("shows staff the days they may see, and nothing of the others", async () => {
    const catalog = await loadCatalog(world.db);
    const forSam = await loadCalendar(world.db, sam, catalog, WEEK);
    expect(forSam.days).toEqual([NEAR]);
    expect(forSam.appointments.map((entry) => entry.ref)).toEqual([morningRef]);
    expect(await loadCalendar(world.db, riley, catalog, WEEK)).toEqual({ appointments: [], blocks: [], days: [] });
    expect(await loadCalendar(world.db, jane, catalog, WEEK)).toEqual({ appointments: [], blocks: [], days: [] });

    await allow("staffSeesAllDays");
    expect((await loadCalendar(world.db, riley, catalog, WEEK)).appointments).toHaveLength(2);
  });
});
