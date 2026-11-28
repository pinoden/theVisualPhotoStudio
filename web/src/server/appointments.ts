import { formsOfBooking, type BookingForms } from "./booking-forms";
import { SERVICE_WORDS, type Service } from "@/lib/domain/services";
import { propsProblem } from "./props";
import { and, eq, sql } from "drizzle-orm";
import { bookingAddons, bookings, payments, photographerHolds, studioHolds } from "@/db/schema";
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
import { durationLabel, isIsoDate, type DayType } from "@/lib/domain/time";
import { can, type Ability } from "@/lib/abilities";
import type { AuthUser } from "./auth";
import { loadDayAvailability, serviceAsked, sessionServiceOf } from "./availability";
import { conflictsAt, everyStart, loadOverrideDay, overlapping, overrideRefusal, type Conflict } from "./override";
import {
  createBooking,
  isBookingRef,
  toBookingViews,
  type BookingDeps,
  type BookingInput,
  type BookingView,
  type CreateBookingResult,
} from "./bookings";
import { dayTypeFor, loadCatalog } from "./catalog";
import { formatCents } from "@/lib/domain/pricing";
import { addRescheduleFee, chargesOf, hasVisitCharges, hourlyRateOf, type ChargeLine } from "./charges";
import { storedTerms, termsChangedSince, termsFor, type BookingTerms } from "./terms";
import { bookingMovedEmail, queueEmail } from "./email";
import { listEvents, recordEvent, withoutAmounts, type BookingEvent } from "./history";
import { creditLeftCentsByBooking, owedCents } from "./money";
import { openPayLinkOf, type PayLinkView } from "./pay-links";
import type { Made, PaymentProvider } from "./payments";
import { PET_CREDIT_BLOCK_TEXT, petCreditStanding, petFeeReturnedCents } from "./pet-fee";
import { addBackToCode } from "./promos";
import { noticeRefundOwed, type OwnerNotice } from "./refund-owed";
import { movePriceText, priceOnNewDay, repriceNote, totalBeforeCredit } from "./reprice";
import { loadSettings, type Settings } from "./settings";
import { canViewDay } from "./staff";
import { moneyOf, type BookingMoney } from "./studio-payments";
import { formatInstant, localDateOf, localToUtc } from "./tz";

/**
 * One appointment as the admin sees it, for both of its levels: the owners,
 * and the staff with whatever the owners have switched on for them
 * (src/lib/abilities.ts). Every function here checks the viewer itself:
 * the role, the ability, and for staff whether the day is one they may see.
 */

export interface Appointment {
  ref: string;
  /** The kind of money the booking is: test mode's, or real (src/server/test-mode.ts). */
  moneyKind: "test" | "live";
  label: LabelKey;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  studios: string[];
  customerName: string;
  /** When the client ticked the studio policies, booking online; null for a booking the studio made (`termsAcceptedAt`). */
  termsAcceptedAt: string | null;
  /** What the client answered and accepted at checkout (src/server/booking-forms.ts). */
  forms: BookingForms;
  /** Set on a session (photography or content creation): what it includes, and whose it is. */
  photography: { includes: string; service: Service } | null;
  /** Null unless the viewer may see contact details. */
  customerPhone: string | null;
  customerEmail: string | null;
  notes: string;
  addons: { name: string; quantity: number }[];
  /** The booking with its amounts. Null unless the viewer may see prices. */
  money: BookingView | null;
  /**
   * What the booking has received and still owes, with each payment. For a
   * viewer who may see prices; and, while the booking still owes something,
   * for one who may record payments, because they have to know what to take.
   * Null otherwise.
   */
  payments: BookingMoney | null;
  /** The payment link that is open for the booking, if one was emailed and not yet paid. Null when `payments` is. */
  payLink: PayLinkView | null;
  /** A cancellation or release the client asked for that waits for the card processor (`BookingView.endRequest`). */
  endRequest: BookingView["endRequest"];
  /**
   * The pet fee on the booking, and whether it can be returned as studio
   * credit now. Null when there is none, and for staff: returning it is the
   * owners' decision.
   */
  /** `returnedCents`: what its credit was issued for, which is part of the fee when only part was paid. */
  /**
   * Extra charges (src/server/charges.ts), for a viewer who may record payments, and for the owners. `canAdd` once the
   * appointment has started; `hourlyCents` is the rate overtime is worked out from, null for a photography session or
   * a studio with no one-hour price that day.
   */
  charges: { lines: ChargeLine[]; canAdd: boolean; overtime: boolean; hourlyCents: number | null; missingRate: string[] } | null;
  /** The terms the booking was made under (question 10), and whether the settings have changed since. */
  terms: BookingTerms & { changedSince: boolean };
  petFee: { cents: number; creditCode: string | null; returnedCents: number; canReturn: boolean; why: string } | null;
  history: BookingEvent[];
  /** Each label that can be set by hand, and whether it can be set right now. */
  labelChoices: { key: SettableLabel; allowed: boolean; why: string }[];
  /** What this viewer may do with the appointment. */
  may: Record<"setLabels" | "move" | "recordPayment" | "changePayments" | "openCustomer" | "refund", boolean>;
  /** Why the booking cannot be moved, where the viewer may otherwise move it: it has extra charges (`CHARGES_BLOCK_MOVE`). */
  moveBlocked: string | null;
  /**
   * The moves that count as the client's so far: their own online, and the studio's at their request. With the terms,
   * it says what the next one they ask for costs (`moveFeeCents`).
   */
  clientMoves: number;
  /**
   * The booking was paid for more than it costs, after a move or a change by the studio: a refund is owed, which an
   * owner makes (src/server/refund-owed.ts). For every viewer, as a fact without its amount: one who cannot see the
   * booking's payments is told that much on its page.
   */
  refundOwed: boolean;
}

/**
 * What a move the client asked the studio for costs them now, by the terms the booking was made under: nothing while
 * a free move is left, or while moving is switched off, and the fee after that (the owners' decision of 2026-11-27).
 */
export function moveFeeCents(clientMoves: number, terms: Pick<Settings, "maxReschedules" | "rescheduleFeeCents">): number {
  return terms.maxReschedules > 0 && clientMoves >= terms.maxReschedules ? terms.rescheduleFeeCents : 0;
}

/**
 * A booking with extra charges of its visit is not moved (the tester's fourth pass of 2026-11-18; the fee for an
 * earlier move is no such charge, `hasVisitCharges`). A charge is added once its visit
 * has started, so the visit has taken place, at least in part; and moved to a day of another price, one booking would
 * hold the price paid for the visit, its charges and the price of the new day, which no reading of its money keeps
 * apart: what paid which, what a refund gave back, what goes into a code. The rest of a shoot is a new booking.
 */
export const CHARGES_BLOCK_MOVE =
  "This booking has extra charges, added once its visit had started, so it cannot be moved. Book the rest of the shoot as a new booking (Calendar, New booking), or first take back a charge added by mistake.";

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
  const may = (ability: Ability) => can(viewer, ability, settings);
  const [view] = await toBookingViews(db, [booking], now);
  const active = ["confirmed", "completed", "no_show"].includes(booking.status);
  const money = await moneyOf(db, booking, now);
  const seesPayments = may("seePrices") || (may("recordPayments") && money.dueCents > 0);
  const pet = viewer.role === "owner" ? await petCreditStanding(db, booking) : null;
  const seesCharges = may("recordPayments") || viewer.role === "owner";
  const rate = seesCharges && booking.photographerId === null ? await hourlyRateOf(db, booking) : null;
  const mayMove = booking.status === "confirmed" && now.getTime() < booking.endAt.getTime() && may("moveBookings");

  return {
    ref: booking.ref,
    moneyKind: booking.moneyKind,
    label: labelOf(booking),
    startAt: view.startAt,
    endAt: view.endAt,
    durationMinutes: booking.durationMinutes,
    studios: view.studios.map((studio) => studio.name),
    customerName: booking.customerName,
    termsAcceptedAt: booking.termsAcceptedAt ? booking.termsAcceptedAt.toISOString() : null,
    forms: await formsOfBooking(db, booking.id),
    photography: view.photography,
    customerPhone: may("seeContact") ? booking.customerPhone : null,
    customerEmail: may("seeContact") ? booking.customerEmail : null,
    notes: booking.notes,
    addons: view.addons.map((addon) => ({ name: addon.name, quantity: addon.quantity })),
    money: may("seePrices") ? view : null,
    payments: seesPayments ? money : null,
    payLink: seesPayments ? await openPayLinkOf(db, booking.id) : null,
    endRequest: view.endRequest,
    terms: { ...storedTerms(booking, settings), changedSince: termsChangedSince(booking, settings) },
    charges: seesCharges
      ? {
          lines: await chargesOf(db, booking.id),
          canAdd: active && now.getTime() >= booking.startAt.getTime() && may("recordPayments"),
          overtime: booking.photographerId === null,
          hourlyCents: rate?.ok ? rate.cents : null,
          missingRate: rate && !rate.ok ? rate.missing : [],
        }
      : null,
    petFee:
      pet && pet.feeCents > 0
        ? {
            cents: pet.feeCents,
            creditCode: pet.given?.code ?? null,
            returnedCents: pet.given ? await petFeeReturnedCents(db, booking.id) : 0,
            canReturn: pet.block === null,
            why: pet.block ? PET_CREDIT_BLOCK_TEXT[pet.block] : "",
          }
        : null,
    // The notes of a refund, a payment or a credit name their amounts: those are for viewers who may see prices.
    history: (await listEvents(db, booking.id)).map((event) => (may("seePrices") ? event : { ...event, note: withoutAmounts(event.note) })),
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
      setLabels: active && may("setLabels"),
      move: mayMove,
      recordPayment: active && money.dueCents > 0 && may("recordPayments"),
      changePayments: viewer.role === "owner",
      openCustomer: may("seeCustomers"),
      refund: may("refund"),
    },
    moveBlocked: mayMove && (await hasVisitCharges(db, booking.id)) ? CHARGES_BLOCK_MOVE : null,
    clientMoves: booking.rescheduledCount,
    refundOwed: money.creditLeftCents > 0,
  };
}

/**
 * Where one card payment of a booking can be seen at the card processor that took it: Square's receipt of it, which
 * shows the receipt number Square's Dashboard finds it by (follow-up 5). For a viewer who sees the booking's payments
 * on its page. Square is asked when the link is followed, with the keys set up now, so a payment taken with Square's
 * other account (sandbox or live) or in test mode is answered with where to look instead.
 */
export async function cardReceiptOf(
  db: DbLike,
  viewer: AuthUser,
  ref: string,
  paymentId: string,
  processor: PaymentProvider | null,
  now: Date,
): Promise<Made<{ url: string }>> {
  const appointment = await getAppointment(db, viewer, ref, now);
  const line = appointment?.payments?.payments.find((payment) => payment.id === paymentId && !payment.byHand);
  if (!line) return { ok: false, message: "That card payment was not found." };
  const [row] = await db
    .select({ provider: payments.provider, providerPaymentId: payments.providerPaymentId })
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.provider, line.processor ?? "")))
    .limit(1);
  if (!row?.providerPaymentId) return { ok: false, message: "The card processor's reference of that payment is not known." };
  if (processor && processor.name === row.provider) return processor.receiptOf(row.providerPaymentId);
  return {
    ok: false,
    message:
      row.provider === "mock"
        ? "That payment was made in test mode, with the pretend card processor, which has no receipt page: no card was charged."
        : row.provider === "square-sandbox"
          ? "That payment was taken with Square's sandbox (its test account), which the site is not set up with now: look it up there."
          : "That payment was taken with Square's live account, which the site is not set up with now: look it up in Square's Dashboard.",
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
  if (!can(viewer, "setLabels", settings)) return { ok: false, reason: "forbidden" };

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
 *
 * `anyTime`, for an owner's form (question 79): every start of the day from now on instead, and under `passes` what
 * each passes over that does (src/server/override.ts). The caller says whether the viewer is an owner.
 */
export async function freeStartsFor(
  db: DbLike,
  selection: { studioIds: string[]; date: string; durationMinutes: number; excludeBookingId?: string; withPhotographer?: boolean | Service; anyTime?: boolean },
  now: Date,
): Promise<{ ok: true; starts: number[]; passes?: Record<number, string[]> } | { ok: false; message: string }> {
  const catalog = await loadCatalog(db);
  const day = await loadDayAvailability(db, catalog, selection.date, now, {
    asAdmin: true,
    excludeBookingId: selection.excludeBookingId,
    withPhotographer: selection.withPhotographer,
  });
  if (day.problem) return { ok: false, message: WINDOW_PROBLEM[day.problem] };
  const days = selection.studioIds.map((id) => day.days.find((studio) => studio.studioId === id));
  if (days.length === 0 || days.some((studio) => !studio)) return { ok: false, message: "Unknown studio." };
  if (selection.anyTime) {
    const plan = await loadOverrideDay(db, catalog, {
      date: selection.date,
      studioIds: selection.studioIds,
      excludeBookingId: selection.excludeBookingId,
      service: serviceAsked(selection.withPhotographer),
    });
    const every = everyStart(plan, {
      durationMinutes: selection.durationMinutes,
      incrementMinutes: catalog.settings.slotIncrementMinutes,
      earliestStartMinute: day.earliestStartMinute,
    });
    return {
      ok: true,
      starts: every.map((start) => start.minute),
      passes: Object.fromEntries(every.filter((start) => start.conflicts.length > 0).map((start) => [start.minute, start.conflicts.map((conflict) => conflict.text)])),
    };
  }
  if (selection.withPhotographer) {
    if (!day.photographer) return { ok: false, message: `There is no ${SERVICE_WORDS[serviceAsked(selection.withPhotographer) ?? "photography"].person} to book.` };
    days.push(day.photographer); // free for the studio and for the session's person
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

/**
 * What moving a booking to another day would do to its money (follow-up 5): its total before and after, as the client
 * reads it (after discounts, before credit and minutes), and then what it owes, what it was paid beyond its price, and
 * what goes back on the code that paid for it. Null when the price stays.
 */
export interface MovePricePreview {
  dayType: DayType;
  wasCents: number;
  nowCents: number;
  owedCents: number;
  creditLeftCents: number;
  codeBackCents: number;
}

/** What the booking's money is after a move to `price`: what it owes, and what it was paid beyond its new price. */
async function moneyAfter(db: DbLike, booking: { id: string; status: string }, totalCents: number, now: Date): Promise<{ owedCents: number; creditLeftCents: number }> {
  const after = { id: booking.id, status: booking.status, totalCents };
  return {
    owedCents: await owedCents(db, after, now),
    creditLeftCents: (await creditLeftCentsByBooking(db, [after])).get(booking.id) ?? 0,
  };
}

/** For the "move" form: the free start times on `date` for this booking, in its own studios and for its own length, and its price that day. */
export async function moveOptions(
  db: DbLike,
  viewer: AuthUser,
  ref: string,
  date: string,
  now: Date,
  /** An owner's form, which shows every start (question 79): ignored for anyone else. */
  options: { anyTime?: boolean } = {},
): Promise<{ ok: true; starts: number[]; passes?: Record<number, string[]>; price: MovePricePreview | null } | { ok: false; message: string }> {
  const settings = await loadSettings(db);
  if (!isBookingRef(ref) || !can(viewer, "moveBookings", settings)) return { ok: false, message: "Booking not found." };
  const [booking] = await db.select().from(bookings).where(eq(bookings.ref, ref)).limit(1);
  if (!booking || !(await maySee(db, viewer, booking.startAt))) return { ok: false, message: "Booking not found." };
  if (await hasVisitCharges(db, booking.id)) return { ok: false, message: CHARGES_BLOCK_MOVE };
  const free = await freeStartsFor(
    db,
    {
      studioIds: await studioIdsOf(db, booking.id),
      date,
      durationMinutes: booking.durationMinutes,
      excludeBookingId: booking.id,
      withPhotographer: await sessionServiceOf(db, booking.photographerId),
      anyTime: Boolean(options.anyTime) && viewer.role === "owner",
    },
    now,
  );
  // A date that cannot be booked is said so first; then one the booking cannot be priced for.
  if (!free.ok) return free;
  const price = await priceOnNewDay(db, booking, date, await loadCatalog(db));
  if (price.kind === "refused") return { ok: false, message: price.message };
  // Nothing the client reads changes (a free hour still pays all of it): no price to show.
  if (price.kind === "same" || !price.announced) return { ...free, price: null };
  return {
    ...free,
    price: {
      dayType: price.dayType,
      wasCents: totalBeforeCredit(booking),
      nowCents: totalBeforeCredit({ totalCents: price.quote.totalCents, creditAppliedCents: price.creditAppliedCents, membershipCents: price.quote.membershipCents }),
      ...(await moneyAfter(db, booking, price.quote.totalCents, now)),
      codeBackCents: price.codeBack?.cents ?? 0,
    },
  };
}

export type MoveResult =
  | { ok: true; startAt: Date; endAt: Date; /** The fee this move added to what the booking owes: 0 for none. */ feeCents: number }
  | { ok: false; reason: "forbidden" | "not_found" | "not_movable" | "invalid_time" | "slot_taken" | "no_price" | "who_asked"; message: string };

/** The move's form was sent without saying who asked for it, which decides what it costs the client. */
const WHO_ASKED = "Say who asked for this move: the client or the studio.";

/**
 * Move a booking to a new date or time, in the same studios and for the same
 * length. A day of the other kind (a weekday for a weekend, or the other way
 * round) prices it for that day, at today's prices (`priceOnNewDay`, follow-up
 * 5): the booking then owes the difference, or was paid beyond its price,
 * which the studio refunds; what was paid stays as it is. The availability
 * rules are the ones every booking obeys: opening hours, no overlap, and the
 * gap between appointments; and the database refuses an overlap whatever
 * happens here. A booking with extra charges is not moved (`CHARGES_BLOCK_MOVE`).
 *
 * `countsAsClientMove` says who asked for the move: true for the client,
 * false for the studio, and null when the form did not say, which is refused
 * while the booking's terms offer moving (the owners' decision of 2026-11-27:
 * the box that said it started ticked, and a move the studio needed then used
 * up the client's free one). A move the studio needs costs the client nothing
 * and counts for nothing. One the client asked for counts as a reschedule of
 * theirs while moving is offered (`maxReschedules` above 0): the booking is
 * no longer refunded automatically, as the rental terms say. Their free moves
 * are the ones they can also make online; after those, each move is the
 * studio's to make and costs the fee of the booking's terms
 * (`rescheduleFeeCents`), added to what the booking owes (a charge,
 * `addRescheduleFee`) and paid at the studio or through a payment link. An
 * owner can let the fee go (`waiveFee`).
 *
 * When the move leaves the booking paid for more than it now costs, the
 * owners are told (`notice`, src/server/refund-owed.ts).
 */
export async function moveBooking(
  db: Db,
  viewer: AuthUser,
  ref: string,
  input: {
    date: string;
    startMinute: number;
    countsAsClientMove: boolean | null;
    /** An owner lets the fee for this move go. Ignored for anyone else, and when the move costs nothing. */
    waiveFee?: boolean;
    /** An owner's override (question 79): the keys of what the new time passes over, read in the pop-up. */
    override?: string[] | null;
  },
  now: Date,
  notice?: OwnerNotice,
): Promise<MoveResult> {
  const refuse = (reason: Extract<MoveResult, { ok: false }>["reason"], message: string): MoveResult => ({ ok: false, reason, message });
  const settings = await loadSettings(db);
  if (!isBookingRef(ref)) return refuse("not_found", "Booking not found.");
  if (!can(viewer, "moveBookings", settings)) return refuse("forbidden", "You cannot move bookings.");

  const [found] = await db.select().from(bookings).where(eq(bookings.ref, ref)).limit(1);
  if (!found) return viewer.role === "owner" ? refuse("not_found", "Booking not found.") : refuse("forbidden", "You cannot move that booking.");
  if (!(await maySee(db, viewer, found.startAt))) return refuse("forbidden", "You cannot move that booking.");
  if (found.status !== "confirmed" || now.getTime() >= found.endAt.getTime()) {
    return refuse("not_movable", "Only a booking that is still to come can be moved.");
  }
  if (found.endRequest) return refuse("not_movable", waitingBlocksMove(found.endRequest));
  if (await hasVisitCharges(db, found.id)) return refuse("not_movable", CHARGES_BLOCK_MOVE);
  if (!isIsoDate(input.date) || !Number.isInteger(input.startMinute) || input.startMinute < 0 || input.startMinute >= 1440) {
    return refuse("invalid_time", "Choose a date and a time.");
  }

  const startAt = localToUtc(input.date, input.startMinute);
  const endAt = localToUtc(input.date, input.startMinute + found.durationMinutes);
  if (startAt.getTime() === found.startAt.getTime()) return refuse("invalid_time", "That is the time the booking already has.");
  // The terms the booking was made under (question 10). With moving switched off in them, the rental terms say nothing
  // about a move, so one made for the client costs them nothing.
  const terms = termsFor(found, settings);
  if (input.countsAsClientMove === null && terms.maxReschedules > 0) return refuse("who_asked", WHO_ASKED);
  const clientMove = input.countsAsClientMove === true && terms.maxReschedules > 0;
  // Across the hour the clocks change, the booking would not last as long as it was paid for.
  if (endAt.getTime() - startAt.getTime() !== found.durationMinutes * 60_000) {
    return refuse("slot_taken", "The clocks change at that time, so the booking cannot move there. Choose another.");
  }

  const catalog = await loadCatalog(db);
  const day = await loadDayAvailability(db, catalog, input.date, now, {
    asAdmin: true,
    excludeBookingId: found.id,
    withPhotographer: await sessionServiceOf(db, found.photographerId),
  });
  if (day.problem) return refuse("invalid_time", WINDOW_PROBLEM[day.problem]);
  const studioIds = await studioIdsOf(db, found.id);
  const slot = {
    durationMinutes: found.durationMinutes,
    incrementMinutes: catalog.settings.slotIncrementMinutes,
    earliestStartMinute: day.earliestStartMinute,
  };
  const photographer = found.photographerId !== null ? (day.photographer ?? null) : null;
  const service = await sessionServiceOf(db, found.photographerId);
  // An owner's override (question 79): what the new time passes over, each thing read in the pop-up.
  const override = viewer.role === "owner" && input.override ? input.override : null;
  let passedOver: Conflict[] = [];
  if (override) {
    if (input.startMinute < day.earliestStartMinute) return refuse("invalid_time", "That time has already passed. Choose a later one.");
    if (found.photographerId !== null && !photographer) return refuse("slot_taken", `There is no ${SERVICE_WORDS[service || "photography"].person} to move it with.`);
    const plan = await loadOverrideDay(db, catalog, { date: input.date, studioIds, excludeBookingId: found.id, service: service || null });
    passedOver = conflictsAt(plan, input.startMinute, found.durationMinutes);
    const refusal = overrideRefusal(passedOver, override);
    if (refusal) return refuse("slot_taken", refusal);
  } else {
    const free = studioIds.every((id) => {
      const studioDay = day.days.find((studio) => studio.studioId === id);
      return studioDay !== undefined && isStartFree(studioDay, input.startMinute, slot);
    });
    if (!free) return refuse("slot_taken", "That time is not free in the studio. Choose another.");
    // A session moves with its person (the photographer, or the content creator), who has to be free at the new time too.
    if (found.photographerId !== null && (!photographer || !isStartFree(photographer, input.startMinute, slot))) {
      return refuse("slot_taken", `The ${SERVICE_WORDS[service || "photography"].person} is not free at that time. Choose another.`);
    }
  }
  const overlaps = overlapping(passedOver);

  const studioNames = catalog.studios.filter((studio) => studioIds.includes(studio.id)).map((studio) => studio.name).join(" + ");
  try {
    return await db.transaction(async (tx): Promise<MoveResult> => {
      const [booking] = await tx.select().from(bookings).where(eq(bookings.id, found.id)).for("update").limit(1);
      if (!booking || booking.status !== "confirmed") return refuse("not_movable", "Only a booking that is still to come can be moved.");
      if (booking.endRequest) return refuse("not_movable", waitingBlocksMove(booking.endRequest));
      // A charge added since the check above: adding one locks the same row (`addCharge`).
      if (await hasVisitCharges(tx, booking.id)) return refuse("not_movable", CHARGES_BLOCK_MOVE);
      // Its props must be free at the new time too (src/server/props.ts): their rows are locked until the move is written.
      const props = await tx.select({ addonId: bookingAddons.addonId, quantity: bookingAddons.quantity }).from(bookingAddons).where(eq(bookingAddons.bookingId, booking.id));
      const propProblem = await propsProblem(tx, props, startAt, endAt, booking.id);
      if (propProblem) return refuse("slot_taken", propProblem);
      // A day of the other kind prices the booking for that day (follow-up 5): worked out on the locked row.
      const price = await priceOnNewDay(tx, booking, input.date, catalog);
      if (price.kind === "refused") return refuse("no_price", price.message);
      const repriced = price.kind === "new" ? price : null;
      // A move the client asked for after their free ones costs the fee of the booking's terms, unless an owner lets it go.
      const feeDueCents = clientMove ? moveFeeCents(booking.rescheduledCount, terms) : 0;
      const waived = feeDueCents > 0 && input.waiveFee === true && viewer.role === "owner";
      const feeCents = waived ? 0 : feeDueCents;
      const freeMoves = `the free ${terms.maxReschedules === 1 ? "one" : "ones"}`;
      const creditBeforeCents = (await creditLeftCentsByBooking(tx, [booking])).get(booking.id) ?? 0;

      await tx
        .update(bookings)
        .set({
          startAt,
          endAt,
          label: "rescheduled",
          rescheduledCount: booking.rescheduledCount + (clientMove ? 1 : 0),
          // A reminder comes again before the new time; to a time closer than the reminder's hours, the email about
          // the move tells the new time, and no reminder follows it (queueReminders).
          reminderSentAt: startAt.getTime() - now.getTime() > catalog.settings.reminderHours * 3_600_000 ? null : now,
          // Its new day's kind, which the next move compares with: priced for it, or both kinds priced alike.
          pricedAs: dayTypeFor(catalog, input.date),
          ...(repriced
            ? {
                studiosSubtotalCents: repriced.quote.studiosSubtotalCents,
                multiStudioDiscountCents: repriced.quote.multiStudioDiscountCents,
                promoDiscountCents: repriced.quote.promoDiscountCents,
                creditAppliedCents: repriced.creditAppliedCents,
                membershipCents: repriced.quote.membershipCents,
                taxCents: repriced.quote.taxCents,
                totalCents: repriced.quote.totalCents,
              }
            : {}),
        })
        .where(eq(bookings.id, booking.id));
      // Each studio keeps its own gap after the booking, as when the booking was made, and takes its new price.
      for (const studioId of [...studioIds].sort()) {
        const buffer = catalog.studios.find((studio) => studio.id === studioId)?.bufferMinutes ?? 0;
        const occupiedEnd = new Date(endAt.getTime() + buffer * 60_000);
        const priceCents = repriced?.quote.studioLines.find((line) => line.studioId === studioId)?.priceCents;
        await tx
          .update(studioHolds)
          .set({
            occupied: sql`tstzrange(${startAt.toISOString()}::timestamptz, ${occupiedEnd.toISOString()}::timestamptz, '[)')`,
            overlapAllowed: overlaps.has(studioId),
            ...(priceCents !== undefined ? { priceCents } : {}),
          })
          .where(sql`${studioHolds.bookingId} = ${booking.id} and ${studioHolds.studioId} = ${studioId}`);
      }
      // Credit the new price no longer needs goes back on the code it came from, as a cancellation by the studio gives it back.
      if (repriced?.codeBack) await addBackToCode(tx, repriced.codeBack.codeId, repriced.codeBack.cents);
      if (feeCents > 0) await addRescheduleFee(tx, booking.id, feeCents, viewer.email, now);

      if (photographer) {
        const heldUntil = new Date(endAt.getTime() + photographer.bufferMinutes * 60_000);
        await tx
          .update(photographerHolds)
          .set({ occupied: sql`tstzrange(${startAt.toISOString()}::timestamptz, ${heldUntil.toISOString()}::timestamptz, '[)')`, overlapAllowed: overlaps.has("person") })
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
        note: `Moved from ${was} to ${is}${clientMove ? ", at the client's request" : ""}${passedOver.length > 0 ? `, over: ${passedOver.map((conflict) => conflict.text).join("; ")}` : ""}${repriced ? repriceNote(repriced, booking) : ""}${
          feeCents > 0
            ? `. ${formatCents(feeCents)} added for a move after ${freeMoves}`
            : waived
              ? `. The ${formatCents(feeDueCents)} fee for a move after ${freeMoves} was waived`
              : ""
        }`,
      });
      // What the booking owes and was paid beyond its price now, the fee counted.
      const money = await moneyAfter(tx, booking, repriced ? repriced.quote.totalCents : booking.totalCents, now);
      const priceNote = movePriceText({
        price: repriced?.announced
          ? {
              dayType: repriced.dayType,
              wasCents: totalBeforeCredit(booking),
              nowCents: totalBeforeCredit({ totalCents: repriced.quote.totalCents, creditAppliedCents: repriced.creditAppliedCents, membershipCents: repriced.quote.membershipCents }),
              codeBack: repriced.codeBack,
            }
          : null,
        fee: { cents: feeCents, freeMoves: terms.maxReschedules },
        ...money,
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
          priceNote,
          ...(clientMove ? { clientAsked: movesLeft(booking.rescheduledCount + 1, terms) } : {}),
        }),
      );
      await noticeRefundOwed(tx, booking, { beforeCents: creditBeforeCents, afterCents: money.creditLeftCents }, `${viewer.email} moved booking ${booking.ref} from ${was} to ${is}.`, notice);
      return { ok: true, startAt, endAt, feeCents };
    });
  } catch (error) {
    // Someone took the time between the check above and the move.
    if (pgErrorCode(error) === PG_EXCLUSION_VIOLATION) return refuse("slot_taken", "That time was just taken. Choose another.");
    throw error;
  }
}

/**
 * Why the studio cannot move a booking the client asked to cancel or release while that waits for the card processor
 * (`waitToEnd` in manage.ts): the client gave the time up, and what they asked for is decided once the site knows.
 */
function waitingBlocksMove(request: "cancel" | "reschedule"): string {
  return `The client has asked to ${request === "cancel" ? "cancel this booking" : "release this booking for a reschedule code"}, and that waits until the site knows whether its payment link was paid, so it cannot be moved meanwhile. See the payment link on this page.`;
}

/** After `count` moves: whether the client can move the booking again online (while free moves are left), and what the studio's move costs them once they cannot. */
function movesLeft(count: number, terms: Pick<Settings, "maxReschedules" | "rescheduleFeeCents">): { canMoveAgain: boolean; againFeeCents: number } {
  return { canMoveAgain: count < terms.maxReschedules, againFeeCents: moveFeeCents(count, terms) };
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
  // `processor`: the one set up now, which says what kind of money the booking is. Left out: none is set up.
  // `override`: an owner's (question 79), ignored for anyone else.
  deps: Pick<BookingDeps, "now" | "baseUrl" | "processor" | "override">,
): Promise<CreateBookingResult | { ok: false; status: 403; code: "forbidden"; message: string }> {
  const settings = await loadSettings(db);
  if (!can(viewer, "createBookings", settings)) {
    return { ok: false, status: 403, code: "forbidden", message: "You cannot make bookings for clients." };
  }
  return createBooking(db, { ...input, acceptTerms: true }, { ...deps, processor: deps.processor ?? null, payments: null, madeBy: viewer.email, override: viewer.role === "owner" ? (deps.override ?? null) : null });
}
