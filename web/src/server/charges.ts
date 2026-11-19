import { and, asc, eq, inArray } from "drizzle-orm";
import { bookingCharges, bookings, priceRules, specialDates, studioHolds, studios } from "@/db/schema";
import type { Db, DbLike } from "@/db/client";
import { can } from "@/lib/abilities";
import { labelOf } from "@/lib/domain/labels";
import { formatCents } from "@/lib/domain/pricing";
import { chargeLabel, type ChargeKind } from "@/lib/charge-label";
import { defaultDayType, durationLabel } from "@/lib/domain/time";
import type { AuthUser } from "./auth";
import { isBookingRef } from "./bookings";
import { recordEvent } from "./history";
import { chargesPaidOf, owedCents, STANDS } from "./money";
import { openPayLinkOf } from "./pay-links";
import { loadSettings } from "./settings";
import { canViewDay } from "./staff";
import { localDateOf } from "./tz";

/**
 * What an appointment costs beyond its price (follow-up 13, the owner's answer of 2026-11-17):
 *
 * - Overtime, at the studio's hourly rate, counted in blocks of 15 minutes: each block started costs a quarter of
 *   the hourly rate. The hourly rate is the one-hour price of each studio of the booking, for its day (weekday or
 *   weekend), added together for a booking of several studios: the builder's reading, recorded in ProjectLibrary.md.
 * - Cleaning and damage, at an amount the administrator types each time, with what it is for.
 *
 * A charge is added once the appointment has started, and adds to what the booking owes (`owedCentsByBooking`): it is
 * then paid at the studio and recorded ("Mark as paid"), or through a payment link, like the rest. Before the start
 * the booking could still be moved or cancelled for a code or a refund, which must not carry a charge with it.
 * Whoever may record payments may add one; one added by mistake is taken back by an owner, while it is still unpaid.
 */

export type { ChargeKind } from "@/lib/charge-label";
export { chargeLabel } from "@/lib/charge-label";

export const CHARGE_KINDS: Record<ChargeKind, string> = { overtime: "Overtime", cleaning: "Cleaning", damage: "Damage" };

export const isChargeKind = (value: string): value is ChargeKind => Object.hasOwn(CHARGE_KINDS, value);

/** The longest overtime added at once: ten hours. */
export const OVERTIME_MAX_MINUTES = 600;

/** The most a cleaning or damage charge can be: $10,000. */
export const CHARGE_MAX_CENTS = 1_000_000;

export const CHARGE_NOTE_MAX = 200;

const BLOCK_MINUTES = 15;

/** The 15-minute blocks started in `minutes`. */
export const overtimeBlocks = (minutes: number) => Math.ceil(minutes / BLOCK_MINUTES);

/** Overtime for `minutes` past the end: a quarter of the hourly rate for each 15 minutes started, to the cent. */
export function overtimeCents(hourlyCents: number, minutes: number): number {
  return Math.round((hourlyCents * overtimeBlocks(minutes)) / 4);
}


export interface ChargeLine {
  id: string;
  kind: ChargeKind;
  /** As the client sees it: "Overtime, 20 minutes". */
  label: string;
  amountCents: number;
  minutes: number | null;
  hourlyCents: number | null;
  note: string;
  createdBy: string;
  at: string;
  /** Taken back by an owner: it no longer counts. */
  voided: boolean;
  voidedBy: string | null;
}

/** Every charge of a booking, in the order they were added, those taken back included. */
export async function chargesOf(db: DbLike, bookingId: string): Promise<ChargeLine[]> {
  const rows = await db.select().from(bookingCharges).where(eq(bookingCharges.bookingId, bookingId)).orderBy(asc(bookingCharges.createdAt));
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    label: chargeLabel(row),
    amountCents: row.amountCents,
    minutes: row.minutes,
    hourlyCents: row.hourlyCents,
    note: row.note,
    createdBy: row.createdBy,
    at: row.createdAt.toISOString(),
    voided: row.voidedAt !== null,
    voidedBy: row.voidedBy,
  }));
}


export type HourlyRate = { ok: true; cents: number } | { ok: false; missing: string[] };

/**
 * The hourly rate overtime is worked out from: the one-hour price of each studio the booking holds, on the booking's
 * day type (a special date counts as the owners set it), added together. `missing` names a studio with no one-hour
 * price for that day.
 */
export async function hourlyRateOf(db: DbLike, booking: { id: string; startAt: Date }): Promise<HourlyRate> {
  const day = localDateOf(booking.startAt);
  const [special] = await db.select({ dayType: specialDates.dayType }).from(specialDates).where(eq(specialDates.day, day)).limit(1);
  const dayType = special?.dayType ?? defaultDayType(day);
  const held = await db
    .selectDistinct({ id: studios.id, name: studios.name, sort: studios.sortOrder })
    .from(studioHolds)
    .innerJoin(studios, eq(studios.id, studioHolds.studioId))
    .where(eq(studioHolds.bookingId, booking.id))
    .orderBy(asc(studios.sortOrder));
  if (held.length === 0) return { ok: false, missing: [] };
  const rules = await db
    .select({ studioId: priceRules.studioId, priceCents: priceRules.priceCents })
    .from(priceRules)
    .where(and(inArray(priceRules.studioId, held.map((studio) => studio.id)), eq(priceRules.dayType, dayType), eq(priceRules.durationMinutes, 60)));
  const missing = held.filter((studio) => !rules.some((rule) => rule.studioId === studio.id)).map((studio) => studio.name);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, cents: rules.reduce((sum, rule) => sum + rule.priceCents, 0) };
}

export type AddChargeInput =
  | { kind: "overtime"; minutes: number; note: string }
  | { kind: "cleaning" | "damage"; amountCents: number; note: string };

export type ChargeResult = { ok: true; amountCents: number; dueCents: number } | { ok: false; message: string };

const NOT_YOURS = "You cannot add a charge to that booking.";

/** Add overtime, or a cleaning or damage charge, to an appointment that has started. The booking's history says so. */
export async function addCharge(db: Db, viewer: AuthUser, ref: string, input: AddChargeInput, now: Date): Promise<ChargeResult> {
  const settings = await loadSettings(db);
  if (!can(viewer, "recordPayments", settings)) return { ok: false, message: "You cannot add charges." };
  if (!isBookingRef(ref)) return { ok: false, message: "Booking not found." };
  const note = input.note.trim().slice(0, CHARGE_NOTE_MAX);
  if (input.kind === "overtime") {
    if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > OVERTIME_MAX_MINUTES) {
      return { ok: false, message: `Enter the minutes past the end, from 1 to ${OVERTIME_MAX_MINUTES}.` };
    }
  } else {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > CHARGE_MAX_CENTS) {
      return { ok: false, message: `Enter the amount of the charge, above zero and at most ${formatCents(CHARGE_MAX_CENTS)}.` };
    }
    if (!note) return { ok: false, message: `Say what the ${input.kind} charge is for: the client sees it on the receipt.` };
  }

  return db.transaction(async (tx): Promise<ChargeResult> => {
    // Locked, so that a payment recorded at the same moment counts this charge or comes after it.
    const [booking] = await tx.select().from(bookings).where(eq(bookings.ref, ref)).for("update").limit(1);
    if (!booking) return { ok: false, message: viewer.role === "owner" ? "Booking not found." : NOT_YOURS };
    if (!(await canViewDay(tx, viewer, localDateOf(booking.startAt)))) return { ok: false, message: NOT_YOURS };
    if (!STANDS.includes(booking.status)) return { ok: false, message: "A charge can be added to a booking that is confirmed or has taken place, not to a cancelled one." };
    if (now.getTime() < booking.startAt.getTime()) return { ok: false, message: "A charge can be added once the appointment has started." };

    let amountCents: number;
    let hourlyCents: number | null = null;
    let minutes: number | null = null;
    if (input.kind === "overtime") {
      if (booking.photographerId !== null) return { ok: false, message: "Overtime is for a studio rental, not a photography session." };
      const rate = await hourlyRateOf(tx, booking);
      if (!rate.ok) {
        return {
          ok: false,
          message: `${rate.missing.join(" and ") || "This booking's studio"} ${rate.missing.length > 1 ? "have" : "has"} no one-hour price for this day under Prices, so overtime cannot be worked out. Add the price, or add the amount as a cleaning or damage charge.`,
        };
      }
      hourlyCents = rate.cents;
      minutes = input.minutes;
      amountCents = overtimeCents(rate.cents, input.minutes);
    } else {
      amountCents = input.amountCents;
    }

    await tx.insert(bookingCharges).values({
      bookingId: booking.id,
      kind: input.kind,
      amountCents,
      minutes,
      hourlyCents,
      note,
      createdBy: viewer.email,
      createdAt: now,
    });
    const dueCents = await owedCents(tx, booking, now);
    const label = labelOf(booking);
    const what =
      input.kind === "overtime"
        ? `Overtime of ${durationLabel(minutes!)} added: ${formatCents(amountCents)} (${overtimeBlocks(minutes!)} × 15 minutes started, each a quarter of ${formatCents(hourlyCents!)} an hour)`
        : `${CHARGE_KINDS[input.kind]} charge of ${formatCents(amountCents)} added`;
    await recordEvent(tx, {
      bookingId: booking.id,
      from: label,
      to: label,
      actor: viewer.email,
      at: now,
      note: `${what}${note ? `: ${note}` : ""}; ${formatCents(dueCents)} to pay`,
    });
    return { ok: true, amountCents, dueCents };
  });
}

export type VoidChargeResult = { ok: true } | { ok: false; message: string };

/**
 * Take back a charge added by mistake. It stays on record, marked as taken back, and no longer counts. Only while
 * what the booking owes still covers it: a charge that was paid is given back as a refund instead. Not while a
 * payment link is open, which asks for an amount that counted it.
 */
export async function voidCharge(db: Db, viewer: AuthUser, chargeId: string, reason: string, now: Date): Promise<VoidChargeResult> {
  if (viewer.role !== "owner") return { ok: false, message: "Only an owner can take a charge back." };
  if (!/^[0-9a-f-]{36}$/i.test(chargeId)) return { ok: false, message: "That charge was not found." };
  return db.transaction(async (tx): Promise<VoidChargeResult> => {
    const [row] = await tx
      .select({ charge: bookingCharges, booking: bookings })
      .from(bookingCharges)
      .innerJoin(bookings, eq(bookings.id, bookingCharges.bookingId))
      .where(eq(bookingCharges.id, chargeId))
      .for("update")
      .limit(1);
    if (!row) return { ok: false, message: "That charge was not found." };
    const { charge, booking } = row;
    if (charge.voidedAt) return { ok: false, message: "That charge was already taken back." };
    const link = await openPayLinkOf(tx, booking.id);
    if (link) {
      return { ok: false, message: `A payment link for ${formatCents(link.amountCents)} is open for this booking. Cancel the link first, then take the charge back.` };
    }
    // Only while nothing was paid of it (question 36), read charge by charge as what the booking owes reads its money
    // (`chargesPaidOf`): the booking's whole balance against this one charge let a paid charge go, or one whose money was
    // given back, and the next charge then went unpaid (the tester's fourth pass of 2026-11-18).
    const share = STANDS.includes(booking.status) ? (await chargesPaidOf(tx, booking, now)).find((line) => line.id === charge.id) : undefined;
    if (share && share.paidCents > 0) {
      return {
        ok: false,
        message:
          share.keptCents > 0
            ? `This charge of ${formatCents(charge.amountCents)} was paid, at least in part. Give it back as a refund instead: the charge then stays on the client's receipt, beside the refund, and is not owed again.`
            : `This charge of ${formatCents(charge.amountCents)} is not owed any more: what was paid for it was given back. It stays on the client's booking and receipt, beside the refund, and needs nothing more.`,
      };
    }
    const why = reason.trim().slice(0, CHARGE_NOTE_MAX);
    await tx.update(bookingCharges).set({ voidedAt: now, voidedBy: viewer.email }).where(eq(bookingCharges.id, charge.id));
    const label = labelOf(booking);
    await recordEvent(tx, {
      bookingId: booking.id,
      from: label,
      to: label,
      actor: viewer.email,
      at: now,
      note: `${chargeLabel(charge)} of ${formatCents(charge.amountCents)} taken back${why ? `: ${why}` : ""}`,
    });
    return { ok: true };
  });
}
