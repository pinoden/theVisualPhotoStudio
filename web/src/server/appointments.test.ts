import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookings, settings, staffShifts, studioHolds } from "@/db/schema";
import { getAppointment, setLabel } from "./appointments";
import type { AuthUser } from "./auth";
import { cancelBooking } from "./manage";
import { getDaySheet } from "./staff";
import { completeVisits } from "./tasks";
import { BASE_URL, createTestWorld, expectOk, h, hoursAfter, NEAR, NOW, type TestWorld } from "./testing";

let world: TestWorld;
let owner: AuthUser;
let sam: AuthUser; // staff, assigned to NEAR
let riley: AuthUser; // staff, assigned to nothing
let jane: AuthUser; // a customer
let morningRef: string; // Bob, Dayglow, 9:00 to 10:00 on NEAR
let nextDayRef: string; // Jane, Blanche, 10:00 to 12:00 the day after

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

  it("gives staff the appointment without contact details or prices, and lets them change its label", async () => {
    const appointment = (await getAppointment(world.db, sam, morningRef, NOW))!;
    expect(appointment).toMatchObject({
      customerName: "Bob Brown",
      customerPhone: null,
      customerEmail: null,
      money: null,
      may: { setLabels: true, move: false },
    });
    expect(JSON.stringify(appointment)).not.toContain("bob@example.com");
    expect(JSON.stringify(appointment)).not.toContain("7800");
  });

  it("follows the owners' switches at once, with nothing redeployed", async () => {
    await allow("staffSeesContact");
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
