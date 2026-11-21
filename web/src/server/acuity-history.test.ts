import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { bookings, payments, studioHolds } from "@/db/schema";
import type { AcuityAppointment } from "@/lib/acuity";
import { importAcuityHistory, type HistoryOptions } from "./acuity-history";
import { importAcuityAppointments } from "./acuity-import";
import { getAppointment } from "./appointments";
import type { AuthUser } from "./auth";
import { listBookingsForEmail } from "./bookings";
import { loyaltyStandingOf } from "./loyalty";
import { loadReceipts } from "./receipts";
import { loadSettings } from "./settings";
import { completeVisits, runScheduledTasks } from "./tasks";
import { BASE_URL, createTestWorld, expectOk, FAR, h, NOW, type TestWorld } from "./testing";

/**
 * The past visits in Acuity, brought in read-only (step 7 of the plan): shown in the client's account, receipts and
 * the admin, at Acuity's price and with what was paid there; holding no time, counting for no loyalty stamp, and
 * sending nothing (questions 51 to 53).
 */
let world: TestWorld;
let owner: AuthUser;
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser("owner@studio.test", "owner", "Olivia");
});

/** The client of the test world's own bookings. */
const JANE = "jane@example.com";

/** A past visit as the export reads, by default Blanche for two hours on Monday 2026-10-05 at 10 am, paid in full online. */
function visit(changes: Partial<AcuityAppointment> = {}): AcuityAppointment {
  return {
    id: "2001",
    row: 2,
    start: { date: "2026-10-05", minute: h(10) },
    end: { date: "2026-10-05", minute: h(12) },
    name: "Jane Smith",
    email: "Jane@Example.com",
    otherEmails: [],
    phone: "407-555-0100",
    type: "Studio Blanche Booking (2 hr)",
    calendar: "Blanche",
    priceCents: 17600,
    markedPaid: true,
    paidOnlineCents: 17600,
    certificate: "",
    notes: "",
    scheduled: "2026-09-20",
    canceled: false,
    label: "Completed",
    ...changes,
  };
}

const on = (date: string, from: number, until: number) => ({ start: { date, minute: h(from) }, end: { date, minute: h(until) } });
const options = (changes: Partial<HistoryOptions> = {}): HistoryOptions => ({ now: NOW, actor: owner.email, moneyKind: "test", write: true, ...changes });

async function bookingOf(acuityId: string) {
  const [row] = await world.db.select().from(bookings).where(eq(bookings.importedFrom, `acuity-history:${acuityId}`));
  return row;
}

const noteOf = async (ref: string) => (await getAppointment(world.db, owner, ref, NOW))!.history.map((line) => line.note);

describe("bringing in Acuity's past visits", () => {
  it("makes each a booking that is over, at Acuity's price, with what was paid there, holding no time and sending nothing", async () => {
    const report = await importAcuityHistory(
      world.db,
      [
        visit(),
        // A bundle on a Saturday: $50 paid online, the rest marked as paid in Acuity.
        visit({ id: "2002", row: 3, ...on("2026-10-10", 13, 15), type: "Blanche + Paris (2 hr)", calendar: "Paris", priceCents: 24500, paidOnlineCents: 5000 }),
        // A no-show, which had paid online.
        visit({ id: "2003", row: 4, ...on("2026-10-06", 10, 11), type: "Studio Dayglow Booking (1 hr)", calendar: "Dayglow", priceCents: 7800, paidOnlineCents: 7800, label: "No-show" }),
        // A session with the photographer, paid with a package's code.
        visit({ id: "2004", row: 5, ...on("2026-10-07", 14, 15), type: "Photography DAYGLOW (1 hr)", calendar: "Dayglow", priceCents: 31500, paidOnlineCents: 0, certificate: "PKG-77" }),
      ],
      options(),
    );
    expect(report).toEqual({ imported: 4, noShows: 1, already: 0, setAside: [], notOver: 0, cancelled: 0 });

    const rental = await bookingOf("2001");
    expect(rental).toMatchObject({
      status: "completed",
      label: null,
      customerName: "Jane Smith",
      customerEmail: JANE,
      totalCents: 17600,
      durationMinutes: 120,
      madeBy: owner.email,
      moneyKind: "test",
      photographerId: null,
      // Nothing is left to send for a visit that is over.
      reminderSentAt: NOW,
      reviewRequestedAt: NOW,
      loyaltyIssuedAt: NOW,
    });
    const bundle = await bookingOf("2002");
    const noShow = await bookingOf("2003");
    const session = await bookingOf("2004");
    expect(noShow.status).toBe("no_show");
    expect(session.photographerId).not.toBeNull();

    // Its studios are kept, in holds that hold no time.
    const holds = await world.db.select().from(studioHolds);
    expect(holds).toHaveLength(5);
    expect(holds.every((hold) => !hold.active)).toBe(true);
    const shared = holds.filter((hold) => hold.bookingId === bundle.id);
    expect(shared.map((hold) => hold.studioId).sort()).toEqual([world.ids.blanche, world.ids.paris].sort());
    expect(shared[0].priceCents + shared[1].priceCents).toBe(24500);

    // What was paid in Acuity is recorded as paid there, by hand.
    const paid = await world.db.select().from(payments).orderBy(asc(payments.amountCents));
    expect(paid.map((row) => [row.amountCents, row.provider, row.method, row.status, row.note])).toEqual([
      [5000, "manual", "acuity", "succeeded", "Paid online in Acuity (appointment 2002)"],
      [7800, "manual", "acuity", "succeeded", "Paid online in Acuity (appointment 2003)"],
      [17600, "manual", "acuity", "succeeded", "Paid online in Acuity (appointment 2001)"],
      [19500, "manual", "acuity", "succeeded", "Marked as paid in Acuity (appointment 2002)"],
      [31500, "manual", "acuity", "succeeded", "Paid in Acuity with the code PKG-77 (appointment 2004)"],
    ]);

    // The client finds them in their account and receipts, owing nothing.
    const views = await listBookingsForEmail(world.db, JANE);
    expect(views.map((view) => view.ref).sort()).toEqual([rental.ref, bundle.ref, noShow.ref, session.ref].sort());
    const receipts = await loadReceipts(world.db, JANE);
    expect(receipts.unpaid).toEqual([]);
    expect(receipts.receipts.find((receipt) => receipt.ref === rental.ref)?.payments.map((payment) => payment.how)).toEqual(["Through Acuity, before this website"]);

    // Its history says where it came from.
    expect(await noteOf(bundle.ref)).toEqual([
      'Imported from Acuity\'s history: appointment 2002, "Blanche + Paris (2 hr)" on 2026-10-10 1:00 PM at $245, booked there 2026-09-20; $50 paid online there, $195 marked as paid there. It counts for no loyalty stamp, and no email was sent.',
    ]);

    // Nothing is sent, now or by the scheduled tasks.
    const summary = await runScheduledTasks(world.db, { ...world.manageDeps({ now: NOW }), email: null });
    expect(summary).toMatchObject({ visitsCompleted: 0, loyaltyCodes: 0, reviewRequestsQueued: 0, remindersQueued: 0 });
    expect(await world.emails()).toEqual([]);
  });

  it("holds no time: two past visits at the same time in one studio both come in", async () => {
    const report = await importAcuityHistory(world.db, [visit(), visit({ id: "2002", row: 3 })], options());
    expect(report.imported).toBe(2);
    expect(await world.db.select().from(studioHolds).where(eq(studioHolds.active, true))).toEqual([]);
  });

  it("counts for no loyalty stamp: five past visits and a new one earn no free hour", async () => {
    const days = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"];
    await importAcuityHistory(world.db, days.map((date, index) => visit({ id: `${2100 + index}`, row: index + 2, ...on(date, 10, 12) })), options());
    const settings = await loadSettings(world.db);
    expect((await loyaltyStandingOf(world.db, JANE, settings)).days).toEqual([]);

    // A visit on the site: had the five counted, it would be the sixth day, and a free hour would be sent that evening.
    expectOk(await world.book({ date: "2026-11-18" }));
    expect((await completeVisits(world.db, new Date("2026-11-18T23:00:00-05:00"), BASE_URL)).codes).toBe(0);
    expect((await loyaltyStandingOf(world.db, JANE, settings)).days).toHaveLength(1);
    expect(await world.emails("loyalty_code")).toEqual([]);
  });

  it("leaves out what is not over or cancelled, sets aside what needs a person with the reason, and records no more than the price as paid", async () => {
    const report = await importAcuityHistory(
      world.db,
      [
        visit({ id: "2201", row: 2, canceled: true }),
        // Not over yet: the import of appointments still to come takes it.
        visit({ id: "2202", row: 3, ...on(FAR, 10, 12) }),
        visit({ id: "2203", row: 4, email: "" }),
        visit({ id: "2204", row: 5, type: "Ceramics Workshop", calendar: "" }),
        visit({ id: "2205", row: 6, label: "ReschedulePend" }),
        visit({ id: "2206", row: 7, markedPaid: false, paidOnlineCents: 0 }),
        // Paid online more than its price (moved in Acuity to a shorter booking, say).
        visit({ id: "2207", row: 8, ...on("2026-10-06", 10, 12), paidOnlineCents: 35200 }),
        // Several addresses in Acuity's Email field: the first is the client's (question 50).
        visit({ id: "2208", row: 9, ...on("2026-10-07", 10, 12), otherEmails: ["Bo@Example.com", "jane@example.com"] }),
      ],
      options(),
    );
    expect(report).toMatchObject({ imported: 2, noShows: 0, already: 0, notOver: 1, cancelled: 1 });
    expect(report.setAside.map((line) => [line.id, line.row, line.when, line.reason])).toEqual([
      ["2203", 4, "2026-10-05 10:00 AM", "it has no email address, so no client's account would show it"],
      ["2204", 5, "2026-10-05 10:00 AM", 'neither its type nor its calendar ("") names a studio of the site'],
      ["2205", 6, "2026-10-05 10:00 AM", "Acuity marks it Reschedule Pending: did the visit take place?"],
      ["2206", 7, "2026-10-05 10:00 AM", "Acuity marks it unpaid ($176 of its $176): settle it there, or say it was paid at the studio"],
    ]);

    const overpaid = await bookingOf("2207");
    expect(await world.db.select({ amountCents: payments.amountCents }).from(payments).where(eq(payments.bookingId, overpaid.id))).toEqual([{ amountCents: 17600 }]);
    expect((await noteOf(overpaid.ref))[0]).toContain("Acuity says $352 was paid online, more than its price: the $176 beyond it is not recorded here.");
    const copied = await bookingOf("2208");
    expect(copied.customerEmail).toBe(JANE);
    expect((await noteOf(copied.ref))[0]).toContain("Acuity also emailed bo@example.com about it.");
  });

  it("brings in each appointment once, whichever import brought it in first", async () => {
    await importAcuityHistory(world.db, [visit()], options());
    // An appointment the import of appointments still to come brought in is left to it.
    const ahead = await importAcuityAppointments(world.db, [visit({ id: "2009", ...on(FAR, 10, 12) })], { ...options(), remind: false });
    expect(ahead.imported.map((line) => line.id)).toEqual(["2009"]);

    const again = await importAcuityHistory(world.db, [visit(), visit({ id: "2009", row: 3, ...on("2026-10-06", 10, 12) })], options());
    expect(again).toMatchObject({ imported: 0, already: 2, setAside: [] });
    // And the other way round: a past visit the history brought in is left alone by the other import.
    const upcoming = await importAcuityAppointments(world.db, [visit({ ...on(FAR, 14, 16) })], { ...options(), remind: false });
    expect(upcoming.already.map((line) => line.id)).toEqual(["2001"]);
    expect(await world.db.select({ id: bookings.id }).from(bookings)).toHaveLength(2);
  });

  it("in a rehearsal, finds what writing would, and writes nothing", async () => {
    const visits = [visit(), visit({ id: "2002", row: 3, email: "" })];
    const rehearsal = await importAcuityHistory(world.db, visits, options({ write: false }));
    expect(rehearsal.imported).toBe(1);
    expect(rehearsal.setAside.map((line) => line.id)).toEqual(["2002"]);
    expect(await world.db.select({ id: bookings.id }).from(bookings)).toEqual([]);
    expect(await world.db.select({ id: studioHolds.id }).from(studioHolds)).toEqual([]);
    expect(await world.db.select({ id: payments.id }).from(payments)).toEqual([]);
    expect((await importAcuityHistory(world.db, visits, options())).imported).toBe(1);
  });
});
