import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { bookings, payments, photographerHolds, studioHolds } from "@/db/schema";
import type { AcuityAppointment } from "@/lib/acuity";
import { importAcuityAppointments, shareOf, type ImportOptions } from "./acuity-import";
import { getAppointment } from "./appointments";
import type { AuthUser } from "./auth";
import { listBookingsForEmail } from "./bookings";
import { loadReceipts } from "./receipts";
import { createTestWorld, expectOk, FAR, h, NOW, type TestWorld } from "./testing";

/**
 * The appointments still to come in Acuity, made bookings here before the switch (step 5 of the plan): they hold
 * their studios and the photographer at their time, keep Acuity's price and what was paid there, and send nothing.
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

/** A Saturday: Acuity priced weekends as weekdays, and its price stands. */
const SATURDAY = "2026-12-12";

/** An appointment as the export reads, by default Blanche for two hours on FAR at 10 am, paid in full online. */
function appointment(changes: Partial<AcuityAppointment> = {}): AcuityAppointment {
  return {
    id: "1001",
    row: 2,
    start: { date: FAR, minute: h(10) },
    end: { date: FAR, minute: h(12) },
    name: "Ana Lima",
    email: "Ana@Client.test",
    phone: "(407) 555-0100",
    type: "Studio Blanche Booking (2  hr)",
    calendar: "Blanche",
    priceCents: 17600,
    markedPaid: true,
    paidOnlineCents: 17600,
    certificate: "",
    notes: "A dog comes too",
    scheduled: "November 1, 2026 9:15am",
    canceled: false,
    ...changes,
  };
}

const options = (changes: Partial<ImportOptions> = {}): ImportOptions => ({ now: NOW, actor: owner.email, moneyKind: "test", write: true, remind: false, ...changes });

async function bookingOf(acuityId: string) {
  const [row] = await world.db.select().from(bookings).where(eq(bookings.importedFrom, `acuity:${acuityId}`));
  return row;
}

/** A booking's holds, as times on the studio's clock: [studio slug, from, until]. */
async function holdsOf(bookingId: string) {
  const slugOf = Object.fromEntries(Object.entries(world.ids).map(([slug, id]) => [id, slug]));
  const rows = await world.db
    .select({ studioId: studioHolds.studioId, priceCents: studioHolds.priceCents, from: sql<Date>`lower(${studioHolds.occupied})`, until: sql<Date>`upper(${studioHolds.occupied})` })
    .from(studioHolds)
    .where(eq(studioHolds.bookingId, bookingId));
  return rows
    .map((row) => [slugOf[row.studioId], new Date(row.from).toISOString(), new Date(row.until).toISOString(), row.priceCents] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

describe("importing Acuity's appointments still to come", () => {
  it("makes each a booking that holds its studios at its time, at Acuity's price, with what was paid there, and sends nothing", async () => {
    const report = await importAcuityAppointments(
      world.db,
      [
        appointment(),
        // A bundle on a Saturday, priced by Acuity as on a weekday, $50 of it paid online.
        appointment({
          id: "1002",
          row: 3,
          start: { date: SATURDAY, minute: h(13) },
          end: { date: SATURDAY, minute: h(15) },
          type: "Blanche + Paris (2 hr)",
          calendar: "Paris",
          priceCents: 24500,
          markedPaid: false,
          paidOnlineCents: 5000,
        }),
        // A session with the photographer, paid with a package's code.
        appointment({
          id: "1003",
          row: 4,
          start: { date: FAR, minute: h(14) },
          end: { date: FAR, minute: h(15) },
          type: "Photography DAYGLOW (1 hr)",
          calendar: "Dayglow",
          priceCents: 31500,
          markedPaid: true,
          paidOnlineCents: 0,
          certificate: "PKG-77",
        }),
      ],
      options(),
    );
    expect(report.refused).toEqual([]);
    expect(report.imported.map((line) => [line.id, line.row, line.when, line.type])).toEqual([
      ["1001", 2, "2026-12-09 10:00 AM", "Studio Blanche Booking (2  hr)"],
      ["1003", 4, "2026-12-09 2:00 PM", "Photography DAYGLOW (1 hr)"],
      ["1002", 3, "2026-12-12 1:00 PM", "Blanche + Paris (2 hr)"],
    ]);
    expect(report.totals).toEqual({ priceCents: 17600 + 24500 + 31500, paidCents: 17600 + 5000 + 31500, dueCents: 19500 });

    const rental = await bookingOf("1001");
    expect(rental).toMatchObject({
      ref: report.imported[0].ref,
      status: "confirmed",
      customerName: "Ana Lima",
      customerEmail: "ana@client.test",
      notes: "A dog comes too",
      durationMinutes: 120,
      totalCents: 17600,
      studiosSubtotalCents: 17600,
      madeBy: owner.email,
      moneyKind: "test",
      pricedAs: "weekday",
      termsAcceptedAt: null,
      // Acuity, which still holds the appointment, sends the reminder.
      reminderSentAt: NOW,
      photographerId: null,
    });
    expect(rental.terms).not.toBeNull();
    // Its time and the studio's clean-up gap after it (15 minutes), as any booking's: 10 am is 15:00 UTC in December.
    expect(await holdsOf(rental.id)).toEqual([["blanche", "2026-12-09T15:00:00.000Z", "2026-12-09T17:15:00.000Z", 17600]]);

    const bundle = await bookingOf("1002");
    expect(bundle).toMatchObject({ totalCents: 24500, pricedAs: "weekend", durationMinutes: 120 });
    // Acuity's price, shared between the studios as the site's own weekend prices for two hours share theirs.
    const shared = await holdsOf(bundle.id);
    expect(shared.map(([slug, from, until]) => [slug, from, until])).toEqual([
      ["blanche", "2026-12-12T18:00:00.000Z", "2026-12-12T20:15:00.000Z"],
      ["paris", "2026-12-12T18:00:00.000Z", "2026-12-12T20:15:00.000Z"],
    ]);
    expect(shared[0][3] + shared[1][3]).toBe(24500);
    expect(shared[0][3]).toBeGreaterThan(shared[1][3]);

    const session = await bookingOf("1003");
    expect(session.photographerId).not.toBeNull();
    const [held] = await world.db
      .select({ until: sql<Date>`upper(${photographerHolds.occupied})` })
      .from(photographerHolds)
      .where(eq(photographerHolds.bookingId, session.id));
    expect(new Date(held.until).toISOString()).toBe("2026-12-09T20:15:00.000Z");

    // What was paid in Acuity is recorded as paid there, by hand: the site cannot refund it.
    const paid = await world.db.select().from(payments).orderBy(payments.amountCents);
    expect(paid.map((row) => [row.amountCents, row.provider, row.method, row.status, row.recordedBy, row.note])).toEqual([
      [5000, "manual", "acuity", "succeeded", owner.email, "Paid online in Acuity (appointment 1002)"],
      [17600, "manual", "acuity", "succeeded", owner.email, "Paid online in Acuity (appointment 1001)"],
      [31500, "manual", "acuity", "succeeded", owner.email, "Paid in Acuity with the code PKG-77 (appointment 1003)"],
    ]);

    // The client finds them in their account, by their email address: what was paid, and what is still to pay at the studio.
    const views = await listBookingsForEmail(world.db, "ana@client.test");
    const view = (ref: string) => views.find((candidate) => candidate.ref === ref)!;
    expect(view(bundle.ref)).toMatchObject({ madeByAdmin: true, receivedCents: 5000, receivedThroughAcuityCents: 5000, receivedAtStudioCents: 0, dueCents: 19500 });
    expect(view(rental.ref)).toMatchObject({ receivedThroughAcuityCents: 17600, dueCents: 0 });
    const receipts = await loadReceipts(world.db, "ana@client.test");
    expect(receipts.receipts.find((receipt) => receipt.ref === rental.ref)?.payments.map((payment) => payment.how)).toEqual(["Through Acuity, before this website"]);

    // Its history says where it came from; and no email went to anyone.
    const history = (await getAppointment(world.db, owner, bundle.ref, NOW))!.history;
    expect(history.map((line) => [line.actor, line.note])).toEqual([
      [
        owner.email,
        'Imported from Acuity: appointment 1002, "Blanche + Paris (2 hr)" at $245, booked there November 1, 2026 9:15am; $50 paid online there, $195 to pay at the studio. No email was sent.',
      ],
    ]);
    expect(await world.emails()).toEqual([]);
  });

  it("imports each appointment once: a second run adds only what is new", async () => {
    const first = await importAcuityAppointments(world.db, [appointment()], options());
    const second = await importAcuityAppointments(world.db, [appointment(), appointment({ id: "1004", row: 3, start: { date: FAR, minute: h(15) }, end: { date: FAR, minute: h(16) }, priceCents: 8800, paidOnlineCents: 8800 })], options());
    expect(second.already).toEqual([{ id: "1001", row: 2, when: "2026-12-09 10:00 AM", type: "Studio Blanche Booking (2  hr)", ref: first.imported[0].ref }]);
    expect(second.imported.map((line) => line.id)).toEqual(["1004"]);
    expect(await world.db.select({ id: bookings.id }).from(bookings)).toHaveLength(2);
  });

  it("in a rehearsal, finds what writing would, and writes nothing", async () => {
    const appointments = [
      appointment(),
      // Booked back to back in Acuity, whose gap is 7 minutes: the site keeps 15.
      appointment({ id: "1005", row: 3, start: { date: FAR, minute: h(12) + 7 }, end: { date: FAR, minute: h(13) + 7 } }),
    ];
    const rehearsal = await importAcuityAppointments(world.db, appointments, options({ write: false }));
    expect(rehearsal.imported.map((line) => line.id)).toEqual(["1001"]);
    expect(rehearsal.refused.map((line) => [line.id, line.reason])).toEqual([
      ["1005", `its time is taken: Studio Blanche is taken then by booking ${rehearsal.imported[0].ref} (Acuity appointment 1001)`],
    ]);
    expect(await world.db.select({ id: bookings.id }).from(bookings)).toEqual([]);
    expect(await world.db.select({ id: studioHolds.id }).from(studioHolds)).toEqual([]);
    expect(await world.db.select({ id: payments.id }).from(payments)).toEqual([]);

    const written = await importAcuityAppointments(world.db, appointments, options());
    expect(written.imported.map((line) => line.id)).toEqual(["1001"]);
    expect(written.refused.map((line) => line.id)).toEqual(["1005"]);
  });

  it("does not import an appointment whose time is taken here, says by what, and imports the others", async () => {
    const online = expectOk(await world.book({ date: FAR, startMinute: h(10), durationMinutes: 120 }));
    const report = await importAcuityAppointments(
      world.db,
      [
        appointment({ start: { date: FAR, minute: h(11) }, end: { date: FAR, minute: h(12) } }),
        appointment({ id: "1006", row: 3, type: "Studio Paris Booking (1 hr)", calendar: "Paris", start: { date: FAR, minute: h(11) }, end: { date: FAR, minute: h(12) } }),
      ],
      options(),
    );
    expect(report.refused).toEqual([
      { id: "1001", row: 2, when: "2026-12-09 11:00 AM", type: "Studio Blanche Booking (2  hr)", reason: `its time is taken: Studio Blanche is taken then by booking ${online.ref}` },
    ]);
    expect(report.imported.map((line) => line.id)).toEqual(["1006"]);
    // Nothing of the refused one stays behind.
    expect(await bookingOf("1001")).toBeUndefined();
  });

  it("leaves out what is over or cancelled, and refuses what the site cannot hold, saying why", async () => {
    const report = await importAcuityAppointments(
      world.db,
      [
        appointment({ id: "2001", start: { date: "2026-11-13", minute: h(10) }, end: { date: "2026-11-13", minute: h(11) } }),
        appointment({ id: "2002", canceled: true }),
        appointment({ id: "2003", type: "Gift card", calendar: "" }),
        appointment({ id: "2004", email: "" }),
        appointment({ id: "2005", email: "not an address" }),
        appointment({ id: "2006", name: " " }),
        appointment({ id: "2007", paidOnlineCents: 20000 }),
        appointment({ id: "2008", type: "Blanche + Dayglow (1 hr)" }),
        appointment({ id: "2009", end: { date: FAR, minute: h(9) } }),
      ],
      options(),
    );
    expect(report.past).toBe(1);
    expect(report.cancelled).toBe(1);
    expect(report.imported).toEqual([]);
    expect(report.refused.map((line) => [line.id, line.reason])).toEqual([
      ["2003", 'neither its type nor its calendar ("") names a studio of the site'],
      ["2004", "it has no email address"],
      ["2005", "its email address does not look like one"],
      ["2006", "it has no client name"],
      ["2007", "$200 was paid online, more than its price of $176: look at it in Acuity"],
      ["2008", "the site does not book these studios together: To book Blanche and Dayglow together, add Paris or choose a different combination."],
      ["2009", "it ends before it starts"],
    ]);
  });

  it("leaves the reminder to the site when asked, and still sends nothing now", async () => {
    await importAcuityAppointments(world.db, [appointment()], options({ remind: true }));
    expect((await bookingOf("1001")).reminderSentAt).toBeNull();
    expect(await world.emails()).toEqual([]);
  });
});

describe("a price shared between studios", () => {
  it("follows the site's own prices, in whole cents that add up, or is even when one has none", () => {
    // 24,500 × 176/312 is 13,820.5 and × 136/312 is 10,679.5: rounded down, and the cent left over goes to the first.
    expect(shareOf(24500, [17600, 13600])).toEqual([13821, 10679]);
    expect(shareOf(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(shareOf(24500, [17600, null])).toEqual([12250, 12250]);
    expect(shareOf(31500, [null])).toEqual([31500]);
  });
});
