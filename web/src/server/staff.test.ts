import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookings, settings, staffShifts } from "@/db/schema";
import type { AuthUser } from "./auth";
import { loadCatalog } from "./catalog";
import { cancelBooking } from "./manage";
import { canViewDay, getDaySheet, listShiftDays, setAttendance } from "./staff";
import { createTestWorld, expectOk, h, hoursAfter, NEAR, NOW, type TestWorld } from "./testing";

let world: TestWorld;
let owner: AuthUser;
let sam: AuthUser; // staff, assigned to NEAR
let riley: AuthUser; // staff, assigned to nothing
let jane: AuthUser; // customer
let morningRef: string;
let afternoonRef: string;
let nextDayRef: string;

const NEXT_DAY = "2026-11-19";
const MORNING_START = new Date("2026-11-18T14:00:00Z"); // 9:00 local

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

  const people = (await loadCatalog(world.db)).addons.find((a) => a.slug === "extra-people-1-2")!;
  const afternoon = expectOk(
    await world.book({
      studioIds: [world.ids.blanche, world.ids.paris],
      startMinute: h(14),
      durationMinutes: 60,
      notes: "Need the white backdrop",
      addons: [{ addonId: people.id, quantity: 1 }],
    }),
  );
  const morning = expectOk(
    await world.book({
      studioIds: [world.ids.dayglow],
      startMinute: h(9),
      durationMinutes: 60,
      customer: { name: "Bob Brown", email: "bob@example.com", phone: "407-555-0111" },
    }),
  );
  const nextDay = expectOk(await world.book({ date: NEXT_DAY }));
  morningRef = morning.ref;
  afternoonRef = afternoon.ref;
  nextDayRef = nextDay.ref;
});

describe("the day sheet", () => {
  it("shows a staff member the bookings of a day they are assigned to, in time order", async () => {
    const sheet = expectOk(await getDaySheet(world.db, sam, NEAR));
    expect(sheet.entries.map((e) => e.ref)).toEqual([morningRef, afternoonRef]);
    expect(sheet.entries[0]).toMatchObject({ time: "9:00 AM – 10:00 AM", studios: ["Studio Dayglow"], customerName: "Bob Brown", status: "confirmed" });
    expect(sheet.entries[1]).toMatchObject({
      time: "2:00 PM – 3:00 PM",
      studios: ["Studio Blanche", "Studio Paris"],
      customerName: "Jane Smith",
      notes: "Need the white backdrop",
      addons: [{ name: "1 to 2 extra people", quantity: 1 }],
    });
  });

  it("never includes prices, payments or references to other days", async () => {
    const sheet = expectOk(await getDaySheet(world.db, sam, NEAR));
    const text = JSON.stringify(sheet);
    expect(Object.keys(sheet.entries[0]).filter((key) => /cent|price|total|paid|amount/i.test(key))).toEqual([]);
    expect(text).not.toContain("8800"); // Blanche + Paris hour prices
    expect(text).not.toContain("6800");
    expect(text).not.toContain(nextDayRef);
  });

  it("hides contact details from staff unless the owner allows them", async () => {
    const hidden = expectOk(await getDaySheet(world.db, sam, NEAR));
    expect(hidden.entries.every((e) => e.customerPhone === null && e.customerEmail === null)).toBe(true);
    expect(JSON.stringify(hidden)).not.toContain("bob@example.com");
    expect(JSON.stringify(hidden)).not.toContain("407-555");

    await world.db.insert(settings).values({ key: "staffSeesContact", value: true });
    const shown = expectOk(await getDaySheet(world.db, sam, NEAR));
    expect(shown.entries[0]).toMatchObject({ customerPhone: "407-555-0111", customerEmail: "bob@example.com" });
  });

  it("refuses every other day, and every person without a shift", async () => {
    expect(await getDaySheet(world.db, sam, NEXT_DAY)).toEqual({ ok: false, reason: "forbidden" });
    expect(await getDaySheet(world.db, sam, "2026-11-17")).toEqual({ ok: false, reason: "forbidden" });
    expect(await getDaySheet(world.db, riley, NEAR)).toEqual({ ok: false, reason: "forbidden" });
    expect(await getDaySheet(world.db, jane, NEAR)).toEqual({ ok: false, reason: "forbidden" });
    expect(await getDaySheet(world.db, sam, "2026-02-30")).toEqual({ ok: false, reason: "invalid_date" });
    expect(await getDaySheet(world.db, sam, "'; drop table bookings; --")).toEqual({ ok: false, reason: "invalid_date" });
    expect(await canViewDay(world.db, sam, NEAR)).toBe(true);
    expect(await canViewDay(world.db, sam, NEXT_DAY)).toBe(false);
  });

  it("shows the owner any day, with contact details", async () => {
    const sheet = expectOk(await getDaySheet(world.db, owner, NEXT_DAY));
    expect(sheet.entries.map((e) => e.ref)).toEqual([nextDayRef]);
    expect(sheet.entries[0].customerEmail).toBe("jane@example.com");
    expect(expectOk(await getDaySheet(world.db, owner, "2027-01-05")).entries).toEqual([]);
  });

  it("leaves out cancelled bookings", async () => {
    await cancelBooking(world.db, afternoonRef, { kind: "owner" }, world.manageDeps());
    expect(expectOk(await getDaySheet(world.db, sam, NEAR)).entries.map((e) => e.ref)).toEqual([morningRef]);
  });

  it("puts an early-morning booking on its own local day", async () => {
    // Saturday 8:00 local is 13:00 UTC; it must not leak onto Friday's sheet.
    const saturday = expectOk(await world.book({ date: "2026-11-21", startMinute: h(8), durationMinutes: 60 }));
    await world.db.insert(staffShifts).values([
      { userId: sam.id, day: "2026-11-20" },
      { userId: sam.id, day: "2026-11-21" },
    ]);
    expect(expectOk(await getDaySheet(world.db, sam, "2026-11-20")).entries).toEqual([]);
    expect(expectOk(await getDaySheet(world.db, sam, "2026-11-21")).entries.map((e) => e.ref)).toEqual([saturday.ref]);
  });

  it("lists a staff member's coming shifts", async () => {
    await world.db.insert(staffShifts).values([
      { userId: sam.id, day: "2026-11-25" },
      { userId: sam.id, day: "2026-11-10" }, // in the past
    ]);
    expect(await listShiftDays(world.db, sam.id, "2026-11-14")).toEqual([NEAR, "2026-11-25"]);
    expect(await listShiftDays(world.db, riley.id, "2026-11-14")).toEqual([]);
  });
});

describe("recording attendance", () => {
  const status = async (ref: string) => (await world.db.select().from(bookings).where(eq(bookings.ref, ref)))[0].status;
  const during = hoursAfter(MORNING_START, 0.5);

  it("lets staff mark a no-show or a completed visit once the booking has started", async () => {
    expect(await setAttendance(world.db, sam, morningRef, "no_show", hoursAfter(MORNING_START, -1))).toEqual({ ok: false, reason: "too_early" });
    expect(await setAttendance(world.db, sam, morningRef, "no_show", during)).toEqual({ ok: true });
    expect(await status(morningRef)).toBe("no_show");
    expect(await setAttendance(world.db, sam, morningRef, "completed", during)).toEqual({ ok: true }); // a correction
    expect(await status(morningRef)).toBe("completed");
  });

  it("refuses bookings on days the staff member is not assigned to, without revealing whether they exist", async () => {
    const later = hoursAfter(NOW, 24 * 10);
    expect(await setAttendance(world.db, sam, nextDayRef, "no_show", later)).toEqual({ ok: false, reason: "forbidden" });
    expect(await setAttendance(world.db, sam, "VS-AAAAAA", "no_show", later)).toEqual({ ok: false, reason: "forbidden" });
    expect(await setAttendance(world.db, riley, morningRef, "no_show", later)).toEqual({ ok: false, reason: "forbidden" });
    expect(await setAttendance(world.db, jane, afternoonRef, "completed", later)).toEqual({ ok: false, reason: "forbidden" });
    expect(await status(nextDayRef)).toBe("confirmed");
    expect(await status(afternoonRef)).toBe("confirmed");
  });

  it("lets the owner record attendance on any day, but not on a cancelled booking", async () => {
    const later = hoursAfter(NOW, 24 * 10);
    expect(await setAttendance(world.db, owner, nextDayRef, "no_show", later)).toEqual({ ok: true });
    await cancelBooking(world.db, afternoonRef, { kind: "owner" }, world.manageDeps());
    expect(await setAttendance(world.db, owner, afternoonRef, "completed", later)).toEqual({ ok: false, reason: "not_changeable" });
    expect(await setAttendance(world.db, owner, "VS-AAAAAA", "completed", later)).toEqual({ ok: false, reason: "not_found" });
  });
});
