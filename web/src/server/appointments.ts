import { eq, sql } from "drizzle-orm";
import { bookings, photographerHolds, studioHolds } from "@/db/schema";
import { PG_EXCLUSION_VIOLATION, pgErrorCode, type Db, type DbLike } from "@/db/client";
import { combinedStarts, isStartFree } from "@/lib/domain/availability";
import {
  LABEL_BLOCK_TEXT,
  labelChange,
  labelOf,
  SETTABLE_LABELS,
  type LabelBlock,
  type LabelKey,
  type SettableLabel,
} from "@/lib/domain/labels";
import { durationLabel, isIsoDate, type IsoDate } from "@/lib/domain/time";
import { can, type StaffAbility } from "@/lib/staff-abilities";
import type { AuthUser } from "./auth";
import { loadDayAvailability } from "./availability";
import {
  createBooking,
  isBookingRef,
  toBookingViews,
  type BookingDeps,
  type BookingInput,
  type BookingView,
  type CreateBookingResult,
} from "./bookings";
import { loadCatalog } from "./catalog";
import { bookingMovedEmail, queueEmail } from "./email";
import { listEvents, recordEvent, type BookingEvent } from "./history";
import { openPayLinkOf, type PayLinkView } from "./pay-links";
import { PET_CREDIT_BLOCK_TEXT, petCreditStanding } from "./pet-fee";
import { loadSettings } from "./settings";
import { canViewDay } from "./staff";
import { moneyOf, type BookingMoney } from "./studio-payments";
import { formatInstant, localDateOf, localToUtc } from "./tz";

/**
 * One appointment as the admin sees it, for both of its levels: the owners,
 * and the staff with whatever the owners have switched on for them
 * (src/lib/staff-abilities.ts). Every function here checks the viewer itself:
 * the role, the ability, and for staff whether the day is one they may see.
 */

export interface Appointment {
  ref: string;
  label: LabelKey;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  studios: string[];
  customerName: string;
  /** Set on a photography session: what it includes. */
  photography: { includes: string } | null;
  /** Null unless the viewer may see contact details. */
  customerPhone: string | null;
  customerEmail: string | null;
  notes: string;
  addons: { name: string; quantity: number }[];
  /** The booking with its amounts. Null unless the viewer may see prices. */
  money: BookingView | null;
  /**
   * What the booking has received and still owes, with each payment. Null
   * unless the viewer may see prices or may record payments.
   */
  payments: BookingMoney | null;
  /** The payment link that is open for the booking, if one was emailed and not yet paid. Null when `payments` is. */
  payLink: PayLinkView | null;
  /**
   * The pet fee on the booking, and whether it can be returned as studio
   * credit now. Null when there is none, and for staff: returning it is the
   * owners' decision.
   */
  petFee: { cents: number; creditCode: string | null; canReturn: boolean; why: string } | null;
  history: BookingEvent[];
  /** Each label that can be set by hand, and whether it can be set right now. */
  labelChoices: { key: SettableLabel; allowed: boolean; why: string }[];
  /** What this viewer may do with the appointment. */
  may: Record<"setLabels" | "move" | "recordPayment" | "changePayments", boolean>;
}

/** The viewer may see this booking: owners always, staff on the days they may see. */
async function maySee(db: DbLike, viewer: AuthUser, startAt: Date): Promise<boolean> {
  return canViewDay(db, viewer, localDateOf(startAt));
}

export async function getAppointment(db: DbLike, viewer: AuthUser, ref: string, now: Date): Promise<Appointment | null> {
  if (!isBookingRef(ref)) return null;
  const [booking] = await db.select().from(bookings).where(eq(bookings.ref, ref)).limit(1);
  // An abandoned checkout is not an appointment.
  if (!booking || booking.status === "pending_payment" || booking.status === "expired") return null;
  if (!(await maySee(db, viewer, booking.startAt))) return null;

  const settings = await loadSettings(db);
  const may = (ability: StaffAbility) => can(viewer, ability, settings);
  const [view] = await toBookingViews(db, [booking]);
  const active = ["confirmed", "completed", "no_show"].includes(booking.status);
  const money = await moneyOf(db, booking);
  const seesPayments = may("staffSeesPrices") || may("staffRecordsPayments");
  const pet = viewer.role === "owner" ? await petCreditStanding(db, booking) : null;

  return {
    ref: booking.ref,
    label: labelOf(booking),
    startAt: view.startAt,
    endAt: view.endAt,
    durationMinutes: booking.durationMinutes,
    studios: view.studios.map((studio) => studio.name),
    customerName: booking.customerName,
    photography: view.photography,
    customerPhone: may("staffSeesContact") ? booking.customerPhone : null,
    customerEmail: may("staffSeesContact") ? booking.customerEmail : null,
    notes: booking.notes,
    addons: view.addons.map((addon) => ({ name: addon.name, quantity: addon.quantity })),
    money: may("staffSeesPrices") ? view : null,
    payments: seesPayments ? money : null,
    payLink: seesPayments ? await openPayLinkOf(db, booking.id) : null,
    petFee:
      pet && pet.feeCents > 0
        ? {
            cents: pet.feeCents,
            creditCode: pet.given?.code ?? null,
            canReturn: pet.block === null,
            why: pet.block ? PET_CREDIT_BLOCK_TEXT[pet.block] : "",
          }
        : null,
    history: await listEvents(db, booking.id),
    labelChoices: SETTABLE_LABELS.map((key) => {
      const change = labelChange(booking, key, now);
      if (change.ok) return { key, allowed: true, why: "" };
      // Beside each button, the reason in a few words. The full sentence is for the message after a refusal.
      const why =
        change.reason === "too_early"
          ? key === "checked_in"
            ? "From an hour before the appointment."
            : "Once the appointment has started."
          : LABEL_BLOCK_TEXT[change.reason];
      return { key, allowed: false, why };
    }),
    may: {
      setLabels: active && may("staffSetsLabels"),
      move: booking.status === "confirmed" && now.getTime() < booking.endAt.getTime() && may("staffMovesBookings"),
      recordPayment: active && money.dueCents > 0 && may("staffRecordsPayments"),
      changePayments: viewer.role === "owner",
    },
  };
}

export type SetLabelResult =
  | { ok: true; label: LabelKey }
  | { ok: false; reason: "forbidden" | "not_found" | LabelBlock };

/**
 * Put a status label on a booking, by hand. The history gets a line with the
 * viewer's address and the time.
 */
export async function setLabel(db: Db, viewer: AuthUser, ref: string, target: SettableLabel, now: Date): Promise<SetLabelResult> {
  if (!isBookingRef(ref)) return { ok: false, reason: "not_found" };
  const settings = await loadSettings(db);
  if (!can(viewer, "staffSetsLabels", settings)) return { ok: false, reason: "forbidden" };

  return db.transaction(async (tx): Promise<SetLabelResult> => {
    // Locked, so two people changing the label at once write two honest history lines.
    const [booking] = await tx.select().from(bookings).where(eq(bookings.ref, ref)).for("update").limit(1);
    // Staff are told "forbidden" for an unknown reference too, so they cannot probe for bookings.
    if (!booking) return { ok: false, reason: viewer.role === "owner" ? "not_found" : "forbidden" };
    if (!(await maySee(tx, viewer, booking.startAt))) return { ok: false, reason: "forbidden" };

    const change = labelChange(booking, target, now);
    if (!change.ok) return change;

    await tx.update(bookings).set({ status: change.status, label: change.label }).where(eq(bookings.id, booking.id));
    await recordEvent(tx, { bookingId: booking.id, from: labelOf(booking), to: target, actor: viewer.email, at: now });
    return { ok: true, label: target };
  });
}

// ── Moving a booking to a new time ───────────────────────────────────────────

const WINDOW_PROBLEM = {
  invalid_date: "Choose a valid date.",
  past: "That date has already passed.",
  too_far: "That date is further ahead than bookings are open.",
} as const;

/**
 * The start times, on one date, at which every one of these studios is free
 * for this long. For an administrator: the customers' notice period does not
 * apply, everything else does. `excludeBookingId` leaves a booking's own time
 * out, so that it can be moved within its own day.
 */
export async function freeStartsFor(
  db: DbLike,
  selection: { studioIds: string[]; date: string; durationMinutes: number; excludeBookingId?: string; withPhotographer?: boolean },
  now: Date,
): Promise<{ ok: true; starts: number[] } | { ok: false; message: string }> {
  const catalog = await loadCatalog(db);
  const day = await loadDayAvailability(db, catalog, selection.date, now, {
    asAdmin: true,
    excludeBookingId: selection.excludeBookingId,
    withPhotographer: selection.withPhotographer,
  });
  if (day.problem) return { ok: false, message: WINDOW_PROBLEM[day.problem] };
  const days = selection.studioIds.map((id) => day.days.find((studio) => studio.studioId === id));
  if (days.length === 0 || days.some((studio) => !studio)) return { ok: false, message: "Unknown studio." };
  if (selection.withPhotographer) {
    if (!day.photographer) return { ok: false, message: "There is no photographer to book." };
    days.push(day.photographer); // free for the studio and for the photographer
  }
  return {
    ok: true,
    starts: combinedStarts(days as NonNullable<(typeof days)[number]>[], {
      durationMinutes: selection.durationMinutes,
      incrementMinutes: catalog.settings.slotIncrementMinutes,
      earliestStartMinute: day.earliestStartMinute,
    }),
  };
}

/** The studios a booking holds. */
async function studioIdsOf(db: DbLike, bookingId: string): Promise<string[]> {
  const rows = await db.select({ studioId: studioHolds.studioId }).from(studioHolds).where(eq(studioHolds.bookingId, bookingId));
  return rows.map((row) => row.studioId);
}

/** For the "move" form: the free start times on `date` for this booking, in its own studios and for its own length. */
export async function moveOptions(
  db: DbLike,
  viewer: AuthUser,
  ref: string,
  date: string,
  now: Date,
): Promise<{ ok: true; starts: number[] } | { ok: false; message: string }> {
  const settings = await loadSettings(db);
  if (!isBookingRef(ref) || !can(viewer, "staffMovesBookings", settings)) return { ok: false, message: "Booking not found." };
  const [booking] = await db.select().from(bookings).where(eq(bookings.ref, ref)).limit(1);
  if (!booking || !(await maySee(db, viewer, booking.startAt))) return { ok: false, message: "Booking not found." };
  return freeStartsFor(
    db,
    {
      studioIds: await studioIdsOf(db, booking.id),
      date,
      durationMinutes: booking.durationMinutes,
      excludeBookingId: booking.id,
      withPhotographer: booking.photographerId !== null,
    },
    now,
  );
}

export type MoveResult =
  | { ok: true; startAt: Date; endAt: Date }
  | { ok: false; reason: "forbidden" | "not_found" | "not_movable" | "invalid_time" | "slot_taken"; message: string };

/**
 * Move a booking to a new date or time, in the same studios and for the same
 * length. What was paid stays as it is. The availability rules are the ones
 * every booking obeys: opening hours, no overlap, and the gap between
 * appointments; and the database refuses an overlap whatever happens here.
 *
 * `countsAsClientMove` says the client asked for the move. It then counts as
 * their one reschedule: the booking is no longer refunded automatically and
 * the client cannot move it again themselves, as the rental terms say. Leave
 * it off when the studio is the one that needs the change.
 */
export async function moveBooking(
  db: Db,
  viewer: AuthUser,
  ref: string,
  input: { date: string; startMinute: number; countsAsClientMove: boolean },
  now: Date,
): Promise<MoveResult> {
  const refuse = (reason: Extract<MoveResult, { ok: false }>["reason"], message: string): MoveResult => ({ ok: false, reason, message });
  const settings = await loadSettings(db);
  if (!isBookingRef(ref)) return refuse("not_found", "Booking not found.");
  if (!can(viewer, "staffMovesBookings", settings)) return refuse("forbidden", "You cannot move bookings.");

  const [found] = await db.select().from(bookings).where(eq(bookings.ref, ref)).limit(1);
  if (!found) return viewer.role === "owner" ? refuse("not_found", "Booking not found.") : refuse("forbidden", "You cannot move that booking.");
  if (!(await maySee(db, viewer, found.startAt))) return refuse("forbidden", "You cannot move that booking.");
  if (found.status !== "confirmed" || now.getTime() >= found.endAt.getTime()) {
    return refuse("not_movable", "Only a booking that is still to come can be moved.");
  }
  if (!isIsoDate(input.date) || !Number.isInteger(input.startMinute)) return refuse("invalid_time", "Choose a date and a time.");

  const startAt = localToUtc(input.date, input.startMinute);
  const endAt = localToUtc(input.date, input.startMinute + found.durationMinutes);
  if (startAt.getTime() === found.startAt.getTime()) return refuse("invalid_time", "That is the time the booking already has.");

  const catalog = await loadCatalog(db);
  const day = await loadDayAvailability(db, catalog, input.date, now, {
    asAdmin: true,
    excludeBookingId: found.id,
    withPhotographer: found.photographerId !== null,
  });
  if (day.problem) return refuse("invalid_time", WINDOW_PROBLEM[day.problem]);
  const studioIds = await studioIdsOf(db, found.id);
  const slot = {
    durationMinutes: found.durationMinutes,
    incrementMinutes: catalog.settings.slotIncrementMinutes,
    earliestStartMinute: day.earliestStartMinute,
  };
  const free = studioIds.every((id) => {
    const studioDay = day.days.find((studio) => studio.studioId === id);
    return studioDay !== undefined && isStartFree(studioDay, input.startMinute, slot);
  });
  if (!free) return refuse("slot_taken", "That time is not free in the studio. Choose another.");
  // A photography session moves with its photographer, who has to be free at the new time as well.
  const photographer = found.photographerId !== null ? (day.photographer ?? null) : null;
  if (found.photographerId !== null && (!photographer || !isStartFree(photographer, input.startMinute, slot))) {
    return refuse("slot_taken", "The photographer is not free at that time. Choose another.");
  }

  const studioNames = catalog.studios.filter((studio) => studioIds.includes(studio.id)).map((studio) => studio.name).join(" + ");
  try {
    return await db.transaction(async (tx): Promise<MoveResult> => {
      const [booking] = await tx.select().from(bookings).where(eq(bookings.id, found.id)).for("update").limit(1);
      if (!booking || booking.status !== "confirmed") return refuse("not_movable", "Only a booking that is still to come can be moved.");

      await tx
        .update(bookings)
        .set({
          startAt,
          endAt,
          label: "rescheduled",
          rescheduledCount: booking.rescheduledCount + (input.countsAsClientMove ? 1 : 0),
        })
        .where(eq(bookings.id, booking.id));
      // Each studio keeps its own gap after the booking, as when the booking was made.
      for (const studioId of [...studioIds].sort()) {
        const buffer = catalog.studios.find((studio) => studio.id === studioId)?.bufferMinutes ?? 0;
        const occupiedEnd = new Date(endAt.getTime() + buffer * 60_000);
        await tx
          .update(studioHolds)
          .set({ occupied: sql`tstzrange(${startAt.toISOString()}::timestamptz, ${occupiedEnd.toISOString()}::timestamptz, '[)')` })
          .where(sql`${studioHolds.bookingId} = ${booking.id} and ${studioHolds.studioId} = ${studioId}`);
      }

      if (photographer) {
        const heldUntil = new Date(endAt.getTime() + photographer.bufferMinutes * 60_000);
        await tx
          .update(photographerHolds)
          .set({ occupied: sql`tstzrange(${startAt.toISOString()}::timestamptz, ${heldUntil.toISOString()}::timestamptz, '[)')` })
          .where(eq(photographerHolds.bookingId, booking.id));
      }

      const was = formatInstant(booking.startAt);
      const is = formatInstant(startAt);
      await recordEvent(tx, {
        bookingId: booking.id,
        from: labelOf(booking),
        to: "rescheduled",
        actor: viewer.email,
        at: now,
        note: `Moved from ${was} to ${is}${input.countsAsClientMove ? ", at the client's request" : ""}`,
      });
      await queueEmail(
        tx,
        bookingMovedEmail({
          to: booking.customerEmail,
          name: booking.customerName,
          ref: booking.ref,
          studios: studioNames,
          was,
          now: is,
          duration: durationLabel(booking.durationMinutes),
        }),
      );
      return { ok: true, startAt, endAt };
    });
  } catch (error) {
    // Someone took the time between the check above and the move.
    if (pgErrorCode(error) === PG_EXCLUSION_VIOLATION) return refuse("slot_taken", "That time was just taken. Choose another.");
    throw error;
  }
}

// ── A booking made in the admin for a client ─────────────────────────────────

/**
 * Make a booking for a client, from the admin. The same rules as a booking
 * made online, except that customers' notice period does not apply and
 * nothing is charged: the price is paid at the studio. The client gets the
 * confirmation email with their own link.
 */
export async function createAdminBooking(
  db: Db,
  viewer: AuthUser,
  input: Omit<BookingInput, "acceptTerms" | "paymentToken" | "expectedTotalCents">,
  deps: Pick<BookingDeps, "now" | "baseUrl">,
): Promise<CreateBookingResult | { ok: false; status: 403; code: "forbidden"; message: string }> {
  const settings = await loadSettings(db);
  if (!can(viewer, "staffCreatesBookings", settings)) {
    return { ok: false, status: 403, code: "forbidden", message: "You cannot make bookings for clients." };
  }
  return createBooking(db, { ...input, acceptTerms: true }, { ...deps, payments: null, madeBy: viewer.email });
}

/** The date of a booking, for links back to its day. */
export function dayOf(startAt: Date): IsoDate {
  return localDateOf(startAt);
}
