import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { bookings, payments, photographerHolds, photographers, studioHolds, studios } from "@/db/schema";
import { pgErrorCode, PG_EXCLUSION_VIOLATION, PG_UNIQUE_VIOLATION, type Db, type DbLike, type Tx } from "@/db/client";
import { studiosOfAppointment, type AcuityAppointment } from "@/lib/acuity";
import { studioCombinationError } from "@/lib/catalog-view";
import { findPrice, formatCents } from "@/lib/domain/pricing";
import { minutesToLabel } from "@/lib/domain/time";
import { formText } from "@/lib/parse";
import { ACUITY_METHOD, MANUAL_PROVIDER } from "@/lib/payment-methods";
import { releaseExpiredHolds } from "./availability";
import { newRef } from "./bookings";
import { dayTypeFor, loadCatalog, type Catalog } from "./catalog";
import { recordEvent } from "./history";
import { emailField, hashToken } from "./input-fields";
import { termsAtBooking } from "./terms";
import type { MoneyKind } from "./test-mode";
import { localToUtc } from "./tz";

/**
 * The appointments still to come in Acuity Scheduling, the old website's
 * booking system, made bookings here before the switch (step 5 of the plan in
 * HANDOFF.md), so that they hold their studios and the photographer like any
 * other booking: from then on the site books around them. Read from Acuity's
 * export by src/lib/acuity.ts; run by scripts/import-acuity.ts.
 *
 * An imported booking keeps what the client agreed in Acuity: its time, its
 * studios and Acuity's price, never the site's price list (a weekend there was
 * priced as a weekday). What was paid in Acuity is recorded as paid there, by
 * hand (`ACUITY_METHOD`): the site cannot refund it, as the money never went
 * through it, so a refund of it is made in Square and recorded here by hand.
 * The rest is paid at the studio, as for a booking made in the admin. Nothing
 * is charged, and no email is sent; the reminder before the visit is left to
 * Acuity unless `remind` says otherwise. What the import decides that the
 * owners have not: question 49 under "Rules built on the builder's reading"
 * in ProjectLibrary.md.
 *
 * Each appointment is imported once: the booking keeps Acuity's id
 * (`bookings.imported_from`), so a second run of the same export, or of a
 * later one, adds only what is new. An appointment whose time is taken here,
 * by a booking, by time blocked in the admin, or by an appointment of the same
 * export once the site's clean-up gap is added, is not imported, and the
 * report says what takes it; so is one the site cannot represent. A cancelled
 * or past appointment is left out.
 *
 * Everything happens in one transaction, which a rehearsal (`write: false`)
 * throws away at the end: it finds exactly what writing would, clashes
 * between the export's own appointments included.
 */

export interface ImportOptions {
  now: Date;
  /** The owner who runs the import: kept as who made the bookings, and in their history. */
  actor: string;
  /** The kind of money the bookings are: that of the card processor of the site they are imported into. */
  moneyKind: MoneyKind;
  /** False: a rehearsal, which works everything out and writes nothing. */
  write: boolean;
  /** True: the site sends its own reminder before each visit. False: Acuity sends one, as it still holds the appointments. */
  remind: boolean;
}

/** An appointment of the export, as the report names it: no client's details. */
export interface ReportLine {
  /** Acuity's appointment id. */
  id: string;
  /** Its row in the file. */
  row: number;
  /** Its start, on the studio's clock: "2026-12-03 10:00 AM". */
  when: string;
  type: string;
}

export interface ImportReport {
  /** Made bookings (in a rehearsal: that would be), with their references. */
  imported: (ReportLine & { ref: string })[];
  /** Imported by an earlier run: left as they are. */
  already: (ReportLine & { ref: string })[];
  /** Not imported, and why: the owners deal with each. */
  refused: (ReportLine & { reason: string })[];
  /** Over by now: not for this import. */
  past: number;
  /** Cancelled in Acuity. */
  cancelled: number;
  /** Of the bookings made: what they cost, what was paid in Acuity, and what is still to pay at the studio. */
  totals: { priceCents: number; paidCents: number; dueCents: number };
}

/** Thrown at the end of a rehearsal, to throw its transaction away. */
class Rehearsal extends Error {}

export const ACUITY_SOURCE = "acuity";

/** Import the appointments that are still to come. */
export async function importAcuityAppointments(db: Db, appointments: readonly AcuityAppointment[], options: ImportOptions): Promise<ImportReport> {
  const report: ImportReport = { imported: [], already: [], refused: [], past: 0, cancelled: 0, totals: { priceCents: 0, paidCents: 0, dueCents: 0 } };
  const ordered = [...appointments].sort(
    (a, b) => a.start.date.localeCompare(b.start.date) || a.start.minute - b.start.minute || a.row - b.row,
  );
  try {
    await db.transaction(async (tx) => {
      await releaseExpiredHolds(tx, options.now);
      const catalog = await loadCatalog(tx);
      // The photographer a session holds: the first of those who work, as the booking screen's (availability.ts).
      const [photographer] = await tx
        .select({ id: photographers.id })
        .from(photographers)
        .where(eq(photographers.active, true))
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
  options: ImportOptions;
  report: ImportReport;
}

async function importOne(tx: Tx, appointment: AcuityAppointment, { catalog, photographerId, options, report }: Context): Promise<void> {
  const line: ReportLine = {
    id: appointment.id,
    row: appointment.row,
    when: `${appointment.start.date} ${minutesToLabel(appointment.start.minute)}`,
    type: appointment.type,
  };
  const refuse = (reason: string) => {
    report.refused.push({ ...line, reason });
  };

  if (appointment.canceled) {
    report.cancelled++;
    return;
  }
  const startAt = localToUtc(appointment.start.date, appointment.start.minute);
  const endAt = localToUtc(appointment.end.date, appointment.end.minute);
  if (endAt.getTime() <= options.now.getTime()) {
    report.past++;
    return;
  }
  const importedFrom = `${ACUITY_SOURCE}:${appointment.id}`;
  const [before] = await tx.select({ ref: bookings.ref }).from(bookings).where(eq(bookings.importedFrom, importedFrom)).limit(1);
  if (before) {
    report.already.push({ ...line, ref: before.ref });
    return;
  }

  // Its real length: across the hour the clocks change, the wall clock's would be wrong.
  const minutes = Math.round((endAt.getTime() - startAt.getTime()) / 60_000);
  if (minutes <= 0) return refuse("it ends before it starts");
  if (minutes > 24 * 60) return refuse("it lasts more than a day");
  const booked = studiosOfAppointment(appointment.type, appointment.calendar, catalog.studios);
  if (!booked) return refuse(`neither its type nor its calendar ("${appointment.calendar}") names a studio of the site`);
  const combination = studioCombinationError(catalog.studios, booked.studioIds);
  if (combination) return refuse(`the site does not book these studios together: ${combination}`);
  if (booked.photography && booked.studioIds.length > 1) return refuse("a session with the photographer is in one studio on the site");
  if (booked.photography && !photographerId) return refuse("it is a session with the photographer, and the site has no photographer to hold");
  const email = emailField.safeParse(appointment.email);
  if (!email.success) return refuse(appointment.email === "" ? "it has no email address" : "its email address does not look like one");
  const name = formText(appointment.name).slice(0, 120);
  if (name === "") return refuse("it has no client name");
  if (appointment.paidOnlineCents > appointment.priceCents) {
    return refuse(`${formatCents(appointment.paidOnlineCents)} was paid online, more than its price of ${formatCents(appointment.priceCents)}: look at it in Acuity`);
  }

  // What was paid in Acuity: online when it was booked, and, when Acuity marks it paid, the rest by other means there
  // (a package or gift certificate code, or money the studio marked as received). The rest is paid at the studio.
  const online = appointment.paidOnlineCents;
  const otherwise = appointment.markedPaid ? appointment.priceCents - online : 0;
  const due = appointment.priceCents - online - otherwise;
  const dayType = dayTypeFor(catalog, appointment.start.date);
  // The price of each studio of a bundle: Acuity's price shared as the site's own prices for that day and length
  // share it, or evenly when one has none. Only the booking's summary shows them.
  const shares = shareOf(
    appointment.priceCents,
    booked.studioIds.map((id) => findPrice(id, dayType, minutes, catalog.rules)),
  );
  const session = booked.photography ? catalog.photoPackages.find((p) => p.studioId === booked.studioIds[0] && p.durationMinutes === minutes) : undefined;
  // Between two sessions the photographer keeps the gap the studios keep between bookings (availability.ts).
  const photographerGap = Math.max(0, ...catalog.studios.map((studio) => studio.bufferMinutes));

  for (let attempt = 0; ; attempt++) {
    const ref = newRef();
    try {
      // A savepoint: an appointment that cannot be held leaves nothing behind, and the others go on.
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
            status: "confirmed",
            holdExpiresAt: null,
            studiosSubtotalCents: appointment.priceCents,
            totalCents: appointment.priceCents,
            pricedAs: dayType,
            // No link is sent: the client finds the booking in their account, by their email address.
            manageTokenHash: hashToken(randomBytes(24).toString("base64url")),
            moneyKind: options.moneyKind,
            photographerId: booked.photography ? photographerId : null,
            photoIncludes: session?.includes ?? null,
            madeBy: options.actor,
            // The client agreed to Acuity's terms, not the site's, which the booking follows from now on.
            termsAcceptedAt: null,
            terms: termsAtBooking(catalog.settings, booked.photography),
            reminderSentAt: options.remind ? null : options.now,
            importedFrom,
            createdAt: options.now,
          })
          .returning({ id: bookings.id });

        // Always take studios in the same order, as `createBooking` does, so that two writers never wait on each other.
        const holds = booked.studioIds.map((studioId, index) => ({ studioId, priceCents: shares[index] })).sort((a, b) => (a.studioId < b.studioId ? -1 : 1));
        for (const hold of holds) {
          const studio = catalog.studios.find((candidate) => candidate.id === hold.studioId)!;
          const occupiedEnd = new Date(endAt.getTime() + studio.bufferMinutes * 60_000);
          await inner.insert(studioHolds).values({
            studioId: hold.studioId,
            bookingId: row.id,
            priceCents: hold.priceCents,
            occupied: sql`tstzrange(${startAt.toISOString()}::timestamptz, ${occupiedEnd.toISOString()}::timestamptz, '[)')`,
          });
        }
        if (booked.photography) {
          const heldUntil = new Date(endAt.getTime() + photographerGap * 60_000);
          await inner.insert(photographerHolds).values({
            photographerId: photographerId!,
            bookingId: row.id,
            occupied: sql`tstzrange(${startAt.toISOString()}::timestamptz, ${heldUntil.toISOString()}::timestamptz, '[)')`,
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
          due > 0 ? `${formatCents(due)} to pay at the studio` : null,
        ].filter((part): part is string => part !== null);
        await recordEvent(inner, {
          bookingId: row.id,
          from: "new",
          to: "confirmed",
          actor: options.actor,
          at: options.now,
          note: `Imported from Acuity: appointment ${appointment.id}, "${appointment.type}" at ${formatCents(appointment.priceCents)}${
            appointment.scheduled ? `, booked there ${appointment.scheduled}` : ""
          }${money.length > 0 ? `; ${money.join(", ")}` : ""}. No email was sent.`,
        });
      });
      report.imported.push({ ...line, ref });
      report.totals.priceCents += appointment.priceCents;
      report.totals.paidCents += online + otherwise;
      report.totals.dueCents += due;
      return;
    } catch (error) {
      const code = pgErrorCode(error);
      if (code === PG_EXCLUSION_VIOLATION) {
        return refuse(await whatTakes(tx, booked.studioIds, startAt, endAt, catalog, booked.photography ? photographerId : null, photographerGap));
      }
      // Another booking has the reference: make another.
      if (code === PG_UNIQUE_VIOLATION && attempt < 5) continue;
      throw error;
    }
  }
}

/** `total` shared in proportion to `weights` (a null or zero one: evenly), in whole cents that add up to it. */
export function shareOf(total: number, weights: readonly (number | null)[]): number[] {
  const usable = weights.every((weight) => weight !== null && weight > 0);
  const base = usable ? (weights as number[]) : weights.map(() => 1);
  const sum = base.reduce((all, weight) => all + weight, 0);
  const shares = base.map((weight) => Math.floor((total * weight) / sum));
  shares[0] += total - shares.reduce((all, share) => all + share, 0);
  return shares;
}

/** What holds the studios or the photographer for an appointment that could not be held: for the report. */
async function whatTakes(
  db: DbLike,
  studioIds: string[],
  startAt: Date,
  endAt: Date,
  catalog: Catalog,
  photographerId: string | null,
  photographerGap: number,
): Promise<string> {
  const during = (until: Date) =>
    sql`tstzrange(${startAt.toISOString()}::timestamptz, ${until.toISOString()}::timestamptz, '[)')`;
  // Each studio with its own clean-up gap, as it would have been held.
  const longest = Math.max(0, ...catalog.studios.filter((studio) => studioIds.includes(studio.id)).map((studio) => studio.bufferMinutes));
  const taken = await db
    .select({ studio: studios.name, ref: bookings.ref, importedFrom: bookings.importedFrom })
    .from(studioHolds)
    .innerJoin(studios, eq(studios.id, studioHolds.studioId))
    .leftJoin(bookings, eq(bookings.id, studioHolds.bookingId))
    .where(
      and(
        eq(studioHolds.active, true),
        inArray(studioHolds.studioId, studioIds),
        sql`${studioHolds.occupied} && ${during(new Date(endAt.getTime() + longest * 60_000))}`,
      ),
    )
    .orderBy(asc(studios.sortOrder))
    .limit(3);
  const by = (ref: string | null, importedFrom: string | null) =>
    ref === null ? "time blocked in the admin" : importedFrom ? `booking ${ref} (Acuity appointment ${importedFrom.replace(`${ACUITY_SOURCE}:`, "")})` : `booking ${ref}`;
  const reasons = taken.map((hold) => `${hold.studio} is taken then by ${by(hold.ref, hold.importedFrom)}`);
  if (photographerId) {
    const busy = await db
      .select({ ref: bookings.ref, importedFrom: bookings.importedFrom })
      .from(photographerHolds)
      .leftJoin(bookings, eq(bookings.id, photographerHolds.bookingId))
      .where(
        and(
          eq(photographerHolds.active, true),
          eq(photographerHolds.photographerId, photographerId),
          sql`${photographerHolds.occupied} && ${during(new Date(endAt.getTime() + photographerGap * 60_000))}`,
        ),
      )
      .limit(2);
    reasons.push(...busy.map((hold) => `the photographer is taken then by ${by(hold.ref, hold.importedFrom)}`));
  }
  // The site keeps a clean-up gap after each booking, which Acuity's may be shorter than.
  return reasons.length > 0 ? `its time is taken: ${[...new Set(reasons)].join("; ")}` : "its time is taken";
}
