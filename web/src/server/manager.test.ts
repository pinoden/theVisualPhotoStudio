import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookings, settings } from "@/db/schema";
import { createAdminBooking, getAppointment, moveBooking, setLabel } from "./appointments";
import type { AuthUser } from "./auth";
import { loadCalendar } from "./calendar";
import { loadCatalog } from "./catalog";
import { getCustomer, listCustomers } from "./customers";
import { sendPayLink } from "./pay-links";
import { givePetFeeCredit } from "./pet-fee";
import { blockPhotographer, savePhotoPackage, listPhotoPackages } from "./photography";
import { canViewDay, getDaySheet } from "./staff";
import { recordStudioPayment, voidStudioPayment } from "./studio-payments";
import { BASE_URL, createTestWorld, expectOk, FAR, h, NEAR, NOW, type TestWorld } from "./testing";

/**
 * The owner's three levels (2026-11-15). A Studio Manager "manages
 * appointments, clients, and selected website content based on assigned
 * permissions". These tests follow one manager, Mia, through the services:
 * what she can always do, what the owners' switches open, and what no switch
 * opens.
 */
let world: TestWorld;
let owner: AuthUser;
let mia: AuthUser; // Studio Manager, with no day assigned to her
let sam: AuthUser; // Studio Attendant, with no day assigned either
let nearRef: string; // Bob, Dayglow, 9:00 to 10:00 on NEAR, paid online
let farRef: string; // Jane, Blanche, FAR

beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser("owner@studio.test", "owner", "Olivia");
  mia = await world.addUser("mia@studio.test", "manager", "Mia");
  sam = await world.addUser("sam@studio.test", "staff", "Sam");
  nearRef = expectOk(
    await world.book({
      studioIds: [world.ids.dayglow],
      startMinute: h(9),
      durationMinutes: 60,
      customer: { name: "Bob Brown", email: "bob@example.com", phone: "407-555-0111" },
    }),
  ).ref;
  farRef = expectOk(await world.book({ date: FAR })).ref;
});

const allow = (key: string, value = true) =>
  world.db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
const dana = { name: "Dana Diaz", email: "dana@example.com", phone: "407-555-0133" };
const adminBooking = (viewer: AuthUser) =>
  createAdminBooking(
    world.db,
    viewer,
    { studioIds: [world.ids.paris], date: NEAR, startMinute: h(14), durationMinutes: 60, customer: dana },
    { now: NOW, baseUrl: BASE_URL },
  );

describe("what a manager can always do", () => {
  it("sees every day and its contact details, with no day assigned, where an attendant sees nothing", async () => {
    expect(await canViewDay(world.db, mia, NEAR)).toBe(true);
    expect(await canViewDay(world.db, mia, FAR)).toBe(true);
    expect(await canViewDay(world.db, sam, NEAR)).toBe(false);

    const sheet = expectOk(await getDaySheet(world.db, mia, NEAR));
    expect(sheet.entries[0]).toMatchObject({ customerName: "Bob Brown", customerPhone: "407-555-0111", customerEmail: "bob@example.com" });
    // Also when the owners hide contact details from attendants: that switch is the attendants'.
    await allow("staffSeesContact", false);
    expect(expectOk(await getDaySheet(world.db, mia, NEAR)).entries[0].customerPhone).toBe("407-555-0111");

    const calendar = await loadCalendar(world.db, mia, await loadCatalog(world.db), { from: "2026-11-15", to: "2026-12-13" });
    expect(calendar.days).toHaveLength(28);
    expect(calendar.appointments.map((entry) => entry.ref).sort()).toEqual([nearRef, farRef].sort());
    expect((await loadCalendar(world.db, sam, await loadCatalog(world.db), { from: "2026-11-15", to: "2026-12-13" })).days).toEqual([]);
  });

  it("changes status labels, moves a booking and makes a booking for a client, with every attendants' switch off", async () => {
    for (const key of ["staffSetsLabels", "staffMovesBookings", "staffCreatesBookings"]) await allow(key, false);
    expect(await setLabel(world.db, mia, nearRef, "reschedule_pending", NOW)).toEqual({ ok: true, label: "reschedule_pending" });
    expect(await moveBooking(world.db, mia, nearRef, { date: NEAR, startMinute: h(15), countsAsClientMove: false }, NOW)).toMatchObject({ ok: true });
    expect((await adminBooking(mia)).ok).toBe(true);
    // An attendant, with those switches off, can do none of it.
    expect(await setLabel(world.db, sam, farRef, "reschedule_pending", NOW)).toMatchObject({ ok: false });
    expect(await adminBooking(sam)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("sets the photographer's time, but not the packages and their prices", async () => {
    expect((await blockPhotographer(world.db, mia, { date: FAR, startMinute: h(9), endMinute: h(12), note: "Away" })).ok).toBe(true);
    const [pack] = await listPhotoPackages(world.db);
    expect(await savePhotoPackage(world.db, mia, pack.id, { priceCents: 100, includes: "", active: true })).toBe(false);
  });
});

describe("what the owners' switches open for a manager", () => {
  it("prices: off until the owners switch it on", async () => {
    const before = (await getAppointment(world.db, mia, nearRef, NOW))!;
    expect(before).toMatchObject({ customerEmail: "bob@example.com", money: null });
    expect(JSON.stringify(before.money)).toBe("null");

    await allow("managerSeesPrices");
    expect((await getAppointment(world.db, mia, nearRef, NOW))!.money).toMatchObject({ totalCents: 7800 });
    // The attendants' own switch is a different one.
    await allow("staffSeesAllDays");
    expect((await getAppointment(world.db, sam, nearRef, NOW))!.money).toBeNull();
  });

  it("taking payments: on by default, and it can be switched off", async () => {
    const made = expectOk(await adminBooking(mia));
    const appointment = (await getAppointment(world.db, mia, made.ref, NOW))!;
    expect(appointment.payments).toMatchObject({ dueCents: 6800 });
    expect(appointment.may).toMatchObject({ recordPayment: true, changePayments: false });
    expect(await recordStudioPayment(world.db, mia, made.ref, { amountCents: 3000, method: "cash", note: "" }, NOW)).toMatchObject({ ok: true, dueCents: 3800 });
    expect(await sendPayLink(world.db, mia, made.ref, { now: NOW, baseUrl: BASE_URL, payments: world.provider })).toMatchObject({ ok: true, amountCents: 3800 });

    await allow("managerRecordsPayments", false);
    expect(await recordStudioPayment(world.db, mia, made.ref, { amountCents: 100, method: "cash", note: "" }, NOW)).toMatchObject({ ok: false, reason: "forbidden" });
    expect((await getAppointment(world.db, mia, made.ref, NOW))!).toMatchObject({ payments: null, may: { recordPayment: false } });

    // She is shown what a booking owes in order to take it, and no longer once nothing is owed:
    // what Bob paid online is a price, and prices are a switch of their own.
    await allow("managerRecordsPayments");
    expect((await getAppointment(world.db, mia, made.ref, NOW))!.payments).toMatchObject({ dueCents: 3800 });
    expect((await getAppointment(world.db, mia, nearRef, NOW))!.payments).toBeNull();
    await allow("managerSeesPrices");
    expect((await getAppointment(world.db, mia, nearRef, NOW))!.payments).toMatchObject({ receivedCents: 7800, dueCents: 0 });
  });

  it("customers: the list and each page, without anything about money unless prices are switched on too", async () => {
    expect((await listCustomers(world.db, mia, { now: NOW }))!.map((customer) => customer.name).sort()).toEqual(["Bob Brown", "Jane Smith"]);
    const page = (await getCustomer(world.db, mia, "bob@example.com", NOW))!;
    expect(page).toMatchObject({ name: "Bob Brown", phone: "407-555-0111", receipts: [], unpaid: [], codes: [], may: { seeMoney: false, correctLoyalty: false } });
    expect(page.upcoming).toHaveLength(1);
    expect(page.upcoming[0]).toMatchObject({ ref: nearRef, totalCents: 0, receivedCents: 0 });
    // Not one amount of the booking ($78) is in what a manager without prices is given.
    expect(JSON.stringify(page)).not.toContain("7800");

    await allow("managerSeesPrices");
    const withMoney = (await getCustomer(world.db, mia, "bob@example.com", NOW))!;
    expect(withMoney.may.seeMoney).toBe(true);
    expect(withMoney.upcoming[0].totalCents).toBe(7800);
    expect(withMoney.receipts).toMatchObject([{ ref: nearRef, paidCents: 7800 }]);

    await allow("managerSeesCustomers", false);
    expect(await listCustomers(world.db, mia, { now: NOW })).toBeNull();
    expect(await getCustomer(world.db, mia, "bob@example.com", NOW)).toBeNull();
  });

  it("says on an appointment where its links may lead: the client's page, and the bookings list", async () => {
    expect((await getAppointment(world.db, mia, nearRef, NOW))!.may).toMatchObject({ openCustomer: true, refund: false });
    await allow("managerRefunds");
    await allow("managerSeesCustomers", false);
    expect((await getAppointment(world.db, mia, nearRef, NOW))!.may).toMatchObject({ openCustomer: false, refund: true });
    expect((await getAppointment(world.db, owner, nearRef, NOW))!.may).toMatchObject({ openCustomer: true, refund: true });
  });
});

describe("the history of an appointment", () => {
  it("says what happened to someone who may not see prices, and never how much", async () => {
    const made = expectOk(await adminBooking(mia));
    expectOk(await recordStudioPayment(world.db, mia, made.ref, { amountCents: 6800, method: "cash", note: "" }, NOW));
    const hidden = (await getAppointment(world.db, mia, made.ref, NOW))!.history.at(-1)!;
    expect(hidden.note).toBe("Payment of (amount not shown) recorded (cash); paid in full");
    expect(JSON.stringify((await getAppointment(world.db, mia, made.ref, NOW))!)).not.toContain("$");
    // The owners, and a manager with prices switched on, read it in full.
    expect((await getAppointment(world.db, owner, made.ref, NOW))!.history.at(-1)!.note).toBe("Payment of $68 recorded (cash); paid in full");
    await allow("managerSeesPrices");
    expect((await getAppointment(world.db, mia, made.ref, NOW))!.history.at(-1)!.note).toBe("Payment of $68 recorded (cash); paid in full");
  });
});

describe("what no switch opens for a manager", () => {
  it("returning a pet fee, and taking back or refunding a recorded payment, stay with the owners", async () => {
    for (const key of ["managerSeesPrices", "managerRecordsPayments", "managerRefunds", "managerSeesCustomers", "managerCorrectsLoyalty", "managerBlocksTime"]) {
      await allow(key);
    }
    const made = expectOk(await adminBooking(mia));
    expectOk(await recordStudioPayment(world.db, mia, made.ref, { amountCents: 6800, method: "cash", note: "" }, NOW));
    const [{ id: bookingId }] = await world.db.select({ id: bookings.id }).from(bookings).where(eq(bookings.ref, made.ref));
    const [payment] = await world.db.select().from((await import("@/db/schema")).payments).where(eq((await import("@/db/schema")).payments.bookingId, bookingId));
    expect(await voidStudioPayment(world.db, mia, payment.id, "A mistake", NOW)).toMatchObject({ ok: false });
    expect(await givePetFeeCredit(world.db, mia, nearRef, { now: NOW, baseUrl: BASE_URL })).toMatchObject({ ok: false, reason: "forbidden" });
    expect((await getAppointment(world.db, mia, nearRef, NOW))!.petFee).toBeNull();
    expect((await getAppointment(world.db, mia, made.ref, NOW))!.may.changePayments).toBe(false);
  });
});

describe("taking the amounts out of a note", () => {
  it("removes every amount and nothing else", async () => {
    const { withoutAmounts } = await import("./history");
    expect(withoutAmounts("Refund $167.20; pet fee of $40 returned as studio credit")).toBe(
      "Refund (amount not shown); pet fee of (amount not shown) returned as studio credit",
    );
    expect(withoutAmounts("Released for a reschedule code worth $1,234.50")).toBe("Released for a reschedule code worth (amount not shown)");
    expect(withoutAmounts("Moved from Wed, Nov 18, 2026, 10:00 AM to Thu, Nov 19, 2026, 2:00 PM")).toBe(
      "Moved from Wed, Nov 18, 2026, 10:00 AM to Thu, Nov 19, 2026, 2:00 PM",
    );
    expect(withoutAmounts("No refund")).toBe("No refund");
    expect(withoutAmounts("")).toBe("");
  });
});
