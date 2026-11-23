import { randomBytes } from "node:crypto";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { bookings, payments, photographers, studioHolds } from "@/db/schema";
import { pgErrorCode, PG_UNIQUE_VIOLATION, type Db, type Tx } from "@/db/client";
import { ACUITY_HISTORY_SOURCE, ACUITY_SOURCE, studiosOfAppointment, type AcuityAppointment } from "@/lib/acuity";
import { findPrice, formatCents } from "@/lib/domain/pricing";
import { minutesToLabel } from "@/lib/domain/time";
import { formText } from "@/lib/parse";
import { ACUITY_METHOD, MANUAL_PROVIDER } from "@/lib/payment-methods";
import { shareOf, type ReportLine } from "./acuity-import";
import { newRef } from "./bookings";
import { dayTypeFor, loadCatalog, type Catalog } from "./catalog";
import { recordEvent } from "./history";
import { emailField, hashToken } from "./input-fields";
import { termsAtBooking } from "./terms";
import type { MoneyKind } from "./test-mode";
import { localToUtc } from "./tz";

/**
 * The past visits in Acuity Scheduling, the old website's booking system,
 * brought in read-only (step 7 of the plan in HANDOFF.md), so that a client's
 * account, their receipts and the admin show the visits they made before this
 * site. Read from Acuity's export by src/lib/acuity.ts; run by
 * scripts/import-acuity.ts with --history.
 *
 * A past visit is a booking that is over: completed, or a no-show where
 * Acuity says so. It keeps Acuity's price, and what Acuity records as paid is
 * recorded as paid there, by hand, as for the appointments still to come
 * (question 49 (b)). Shown, not counted, until the owners say otherwise
 * (questions 51 to 53 in ProjectLibrary.md):
 * - it holds no time: its studios are kept in holds that are not active, which
 *   the rule against overlaps and the booking screen leave out;
 * - it counts for no loyalty stamp (`loyaltyStandingOf`);
 * - nothing is sent for it, now or later: its reminder, review request and
 *   loyalty look are marked done at the import;
 * - it never shows money owed: one Acuity marks unpaid is set aside for a
 *   person, and what was paid online beyond its price is not recorded as paid.
 *
 * Each appointment is imported once, by this import or the one of appointments
 * still to come (`bookings.imported_from`). A cancelled appointment, and one
 * not over yet (the other import's), are left out. Everything happens in one
 * transaction, which a rehearsal (`write: false`) throws away at the end.
 */

export interface HistoryOptions {
  now: Date;
  /** The owner who runs the import: kept as who made the bookings, and in their history. */
  actor: string;
  /** The kind of money the bookings are: that of the card processor of the site they are imported into. */
  moneyKind: MoneyKind;
  /** False: a rehearsal, which works everything out and writes nothing. */
  write: boolean;
}

export interface HistoryReport {
  /** Past visits made bookings (in a rehearsal: that would be). */
  imported: number;
  /** Of those, the visits Acuity marks as no-shows. */
  noShows: number;
  /** Imported by an earlier run of either import: left as they are. */
  already: number;
  /** Not imported, and why: each needs a person. */
  setAside: (ReportLine & { reason: string })[];
  /** Not over yet: for the import of appointments still to come. */
  notOver: number;
  /** Cancelled in Acuity. */
  cancelled: number;
}

/** Thrown at the end of a rehearsal, to throw its transaction away. */
class Rehearsal extends Error {}

/** Bring in the visits that are over. */
export async function importAcuityHistory(db: Db, appointments: readonly AcuityAppointment[], options: HistoryOptions): Promise<HistoryReport> {
  const report: HistoryReport = { imported: 0, noShows: 0, already: 0, setAside: [], notOver: 0, cancelled: 0 };
  const ordered = [...appointments].sort(
    (a, b) => a.start.date.localeCompare(b.start.date) || a.start.minute - b.start.minute || a.row - b.row,
  );
  try {
    await db.transaction(async (tx) => {
      const catalog = await loadCatalog(tx);
      // The photographer a session names: the first of those who work, as the import of appointments still to come.
      const [photographer] = await tx
        .select({ id: photographers.id })
        .from(photographers)
        .where(and(eq(photographers.active, true), eq(photographers.service, "photography")))
        .orderBy(asc(photographers.sortOrder), asc(photographers.name))
        .limit(1);
      for (const appointment of ordered) {
        await importOne(tx, appointment, { catalog, photographerId: photographer?.id ?? null, options, report });
      }
      if (!options.write) throw new Rehearsal();
    });
  } catch (error) {
    if (!(error instanceof Rehearsal)) throw error;
  }
  return report;
}

interface Context {
  catalog: Catalog;
  photographerId: string | null;
  options: HistoryOptions;
  report: HistoryReport;
}

async function importOne(tx: Tx, appointment: AcuityAppointment, { catalog, photographerId, options, report }: Context): Promise<void> {
  const line: ReportLine = {
    id: appointment.id,
    row: appointment.row,
    when: `${appointment.start.date} ${minutesToLabel(appointment.start.minute)}`,
    type: appointment.type,
  };
  const setAside = (reason: string) => {
    report.setAside.push({ ...line, reason });
  };

  if (appointment.canceled) {
    report.cancelled++;
    return;
  }
  const startAt = localToUtc(appointment.start.date, appointment.start.minute);
  const endAt = localToUtc(appointment.end.date, appointment.end.minute);
  if (endAt.getTime() > options.now.getTime()) {
    report.notOver++;
    return;
  }
  const [before] = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      or(
        eq(bookings.importedFrom, `${ACUITY_HISTORY_SOURCE}:${appointment.id}`),
        eq(bookings.importedFrom, `${ACUITY_SOURCE}:${appointment.id}`),
      ),
    )
    .limit(1);
  if (before) {
    report.already++;
    return;
  }

  const minutes = Math.round((endAt.getTime() - startAt.getTime()) / 60_000);
  if (minutes <= 0) return setAside("it ends before it starts");
  if (minutes > 24 * 60) return setAside("it lasts more than a day");
  const booked = studiosOfAppointment(appointment.type, appointment.calendar, catalog.studios);
  if (!booked) return setAside(`neither its type nor its calendar ("${appointment.calendar}") names a studio of the site`);
  if (booked.photography && !photographerId) return setAside("it is a session with the photographer, and the site has no photographer");
  const email = emailField.safeParse(appointment.email);
  if (!email.success) {
    return setAside(appointment.email === "" ? "it has no email address, so no client's account would show it" : "its email address does not look like one");
  }
  const name = formText(appointment.name).slice(0, 120);
  if (name === "") return setAside("it has no client name");
  if (/^reschedule\s*pend/i.test(appointment.label)) return setAside("Acuity marks it Reschedule Pending: did the visit take place?");

  // What was paid in Acuity: online, up to its price, and the rest when Acuity marks it paid. A past visit never owes:
  // one Acuity marks unpaid waits for a person (question 52).
  const online = Math.min(appointment.paidOnlineCents, appointment.priceCents);
  const otherwise = appointment.markedPaid ? appointment.priceCents - online : 0;
  const unpaid = appointment.priceCents - online - otherwise;
  if (unpaid > 0) {
    return setAside(
      `Acuity marks it unpaid (${formatCents(unpaid)} of its ${formatCents(appointment.priceCents)}): settle it there, or say it was paid at the studio`,
    );
  }
  const beyond = appointment.paidOnlineCents - online;
  const noShow = /^no[\s-]?show$/i.test(appointment.label);
  // The addresses Acuity copied its emails to besides the client's own: named in the history (question 50).
  const copied = [
    ...new Set(
      appointment.otherEmails.flatMap((other) => {
        const address = emailField.safeParse(other);
        return address.success && address.data !== email.data ? [address.data] : [];
      }),
    ),
  ];
  const dayType = dayTypeFor(catalog, appointment.start.date);
  const shares = shareOf(
    appointment.priceCents,
    booked.studioIds.map((id) => findPrice(id, dayType, minutes, catalog.rules)),
  );

  for (let attempt = 0; ; attempt++) {
    const ref = newRef();
    try {
      // A savepoint: a visit that cannot be written leaves nothing behind, and the others go on.
      await tx.transaction(async (inner) => {
        const [row] = await inner
          .insert(bookings)
          .values({
            ref,
            customerName: name,
            customerEmail: email.data,
            customerPhone: formText(appointment.phone).slice(0, 40),
            notes: formText(appointment.notes).slice(0, 2000),
            startAt,
            endAt,
            durationMinutes: minutes,
            status: noShow ? "no_show" : "completed",
            holdExpiresAt: null,
            studiosSubtotalCents: appointment.priceCents,
            totalCents: appointment.priceCents,
            pricedAs: dayType,
            manageTokenHash: hashToken(randomBytes(24).toString("base64url")),
            moneyKind: options.moneyKind,
            photographerId: booked.photography ? photographerId : null,
            madeBy: options.actor,
            termsAcceptedAt: null,
            terms: termsAtBooking(catalog.settings, booked.photography),
            // Its visit is over: no reminder, no review request, and the loyalty task has nothing to look at.
            reminderSentAt: options.now,
            reviewRequestedAt: options.now,
            loyaltyIssuedAt: options.now,
            importedFrom: `${ACUITY_HISTORY_SOURCE}:${appointment.id}`,
            createdAt: options.now,
          })
          .returning({ id: bookings.id });

        // Its studios, holding no time: a hold that is not active is outside the rule against overlaps, and the
        // booking screen does not read it.
        for (const [index, studioId] of booked.studioIds.entries()) {
          await inner.insert(studioHolds).values({
            studioId,
            bookingId: row.id,
            priceCents: shares[index],
            active: false,
            occupied: sql`tstzrange(${startAt.toISOString()}::timestamptz, ${endAt.toISOString()}::timestamptz, '[)')`,
          });
        }

        const paidThere = [
          { cents: online, note: `Paid online in Acuity (appointment ${appointment.id})` },
          {
            cents: otherwise,
            note: appointment.certificate
              ? `Paid in Acuity with the code ${appointment.certificate} (appointment ${appointment.id})`
              : `Marked as paid in Acuity (appointment ${appointment.id})`,
          },
        ].filter((part) => part.cents > 0);
        for (const part of paidThere) {
          await inner.insert(payments).values({
            bookingId: row.id,
            provider: MANUAL_PROVIDER,
            method: ACUITY_METHOD,
            amountCents: part.cents,
            status: "succeeded",
            recordedBy: options.actor,
            note: part.note.slice(0, 200),
            createdAt: options.now,
          });
        }

        const money = [
          online > 0 ? `${formatCents(online)} paid online there` : null,
          otherwise > 0 ? `${formatCents(otherwise)} marked as paid there${appointment.certificate ? ` (code ${appointment.certificate})` : ""}` : null,
        ].filter((part): part is string => part !== null);
        const sentences = [
          `Imported from Acuity's history: appointment ${appointment.id}, "${appointment.type}" on ${line.when} at ${formatCents(appointment.priceCents)}${
            appointment.scheduled ? `, booked there ${appointment.scheduled}` : ""
          }${money.length > 0 ? `; ${money.join(", ")}` : ""}.`,
          beyond > 0 ? `Acuity says ${formatCents(appointment.paidOnlineCents)} was paid online, more than its price: the ${formatCents(beyond)} beyond it is not recorded here.` : null,
          copied.length > 0 ? `Acuity also emailed ${copied.join(", ")} about it.` : null,
          "It counts for no loyalty stamp, and no email was sent.",
        ].filter((sentence): sentence is string => sentence !== null);
        await recordEvent(inner, {
          bookingId: row.id,
          from: "new",
          to: noShow ? "no_show" : "completed",
          actor: options.actor,
          at: options.now,
          note: sentences.join(" "),
        });
      });
      report.imported++;
      if (noShow) report.noShows++;
      return;
    } catch (error) {
      // Another booking has the reference: make another.
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION && attempt < 5) continue;
      throw error;
    }
  }
}
