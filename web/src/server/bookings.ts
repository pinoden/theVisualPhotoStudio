import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { bookingAddons, bookings, payments, photographerHolds, promoCodes, studioHolds, studios } from "@/db/schema";
import {
  PG_DEADLOCK_DETECTED,
  PG_EXCLUSION_VIOLATION,
  PG_UNIQUE_VIOLATION,
  pgErrorCode,
  together,
  type Db,
  type DbLike,
} from "@/db/client";
import { extraGuestsFor, studioCombinationError } from "@/lib/catalog-view";
import { isStartFree, noticeHours } from "@/lib/domain/availability";
import { labelOf, type LabelKey } from "@/lib/domain/labels";
import { formatCents, PricingError, PROMO_MISFIT_TEXT, quote, type PromoKind, type Quote } from "@/lib/domain/pricing";
import { count, hoursInWords } from "@/lib/words";
import { durationLabel, isIsoDate } from "@/lib/domain/time";
import { loadDayAvailability, releaseExpiredHolds } from "./availability";
import { dayTypeFor, loadCatalog, type Catalog, type CatalogPhotoPackage } from "./catalog";
import { bookingConfirmationEmail, queueEmail } from "./email";
import { BY_CUSTOMER, recordEvent } from "./history";
import { releaseHolds } from "./holds";
import { giveBackReserved, takeReserved } from "./reserved";
import { activeChargesByBooking, creditLeftCentsByBooking, creditReturnedCentsByBooking, heldCentsByBooking, owedCentsByBooking, receivedCentsByBooking } from "./money";
import { emailField, hashToken, textField } from "./input-fields";
import { giveBackUnmadeMinutes, takeBookingMinutes } from "./membership-minutes";
import { findUsableMembership, isMembershipCode, type UsableMembership } from "./memberships";
export { hashToken };
import { RESERVE_HOURS, type PaymentProvider } from "./payments";
import {
  creditName,
  findUsablePromo,
  PROMO_PROBLEM_TEXT,
  redeemPromo,
  restorePromo,
  type PromoSource,
  type UsablePromo,
} from "./promos";
import { loadAccessInstructions } from "./settings";
import { termsAtBooking } from "./terms";
import { moneyKindNow, moneyKindOf, moneyKindOfCode, OTHER_MONEY_CODE } from "./test-mode";
import { formatInstant, localToUtc } from "./tz";

const addonsField = z
  .array(z.object({ addonId: z.uuid(), quantity: z.number().int().min(1).max(20) }))
  .max(20)
  .default([]);

export const bookingInput = z.object({
  studioIds: z.array(z.uuid()).min(1).max(10),
  date: z.string().max(10),
  startMinute: z.number().int().min(0).max(1439),
  durationMinutes: z.number().int().positive().max(1440),
  customer: z.object({
    name: textField(2, 120),
    email: emailField,
    phone: textField(7, 40),
  }),
  notes: textField(0, 2000).default(""),
  addons: addonsField,
  /** A discount, reward, credit or membership code. */
  promoCode: textField(0, 40).optional(),
  /**
   * A photography session with the in-house photographer, in one studio. The
   * price is the package's, which includes the studio, and the photographer
   * is held for the time as well as the studio.
   */
  photography: z.boolean().default(false),
  acceptTerms: z.literal(true),
  paymentToken: z.string().min(1).max(1000).optional(),
  /** The total the customer was shown. A mismatch stops the booking before any charge. */
  expectedTotalCents: z.number().int().nonnegative().optional(),
  /**
   * The id the booking screen gave this attempt, a random UUID. The screen
   * sends it again, unchanged, only when it got no answer; any answer makes
   * it take a new one. See `requestKey` in the schema.
   */
  requestId: z.uuid().optional(),
});

export type BookingInput = z.input<typeof bookingInput>;

export type BookingErrorCode =
  | "invalid_input"
  | "unknown_studio"
  | "not_bookable_date"
  | "invalid_price"
  | "invalid_code"
  | "price_changed"
  | "slot_taken"
  | "payment_required"
  | "payments_unavailable"
  | "payment_failed"
  | "in_progress"
  | "attempt_over";

export type CreateBookingResult =
  | { ok: true; ref: string; manageToken: string; totalCents: number }
  | { ok: false; status: number; code: BookingErrorCode; message: string };

export interface BookingDeps {
  now: Date;
  /** null when no processor is configured: paid bookings are refused. */
  payments: PaymentProvider | null;
  /** Site origin, used for links in emails. */
  baseUrl: string;
  /** Who is told when a charge got no answer and a person has to check the processor. */
  ownerEmail?: string | null;
  /**
   * The address of the administrator who is making this booking for a client
   * (see `createAdminBooking`). Nothing is charged online: the client pays at
   * the studio. The notice period does not apply; every other rule does.
   */
  madeBy?: string;
  /**
   * The name of the card processor set up now, for a booking it does not charge (one made in the admin): it says
   * the kind of money the booking is (`moneyKindNow` in src/server/test-mode.ts). Left out, the name of `payments`.
   */
  processor?: string | null;
}

const REF_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function newRef(): string {
  let out = "VS-";
  for (let i = 0; i < 6; i++) out += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return out;
}


function fail<T extends string>(status: number, code: T, message: string) {
  return { ok: false as const, status, code, message };
}

/** The fields a customer types, by the names the screen gives them. The limits are the schema's, and the screen's fields keep to them. */
const FIELD_WORDS: Record<string, string> = {
  "customer.email": "Please check the email address: it does not look like one.",
  "customer.name": "Please check your name: from 2 to 120 characters.",
  "customer.phone": "Please check the phone number: from 7 to 40 characters.",
  notes: "Please make the notes shorter: at most 2,000 characters.",
};

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const field = issue?.path.join(".") || "request";
  return FIELD_WORDS[field] ?? `Please check ${field}: ${issue?.message ?? "invalid value"}.`;
}

/** Raised inside the booking transaction when the code was spent by another request. */
class PromoGone extends Error {}
/** A membership's minutes were spent by another booking between the price and the hold. */
class MinutesGone extends Error {}

type ParsedInput = z.output<typeof bookingInput>;

/**
 * An attempt to book sent again, by a screen that got no answer: what became
 * of it. Null when it is not one the site has seen, and then it is a new
 * booking. A booking that was made is answered as it was the first time, with
 * a second link of its own (the first is in the confirmation email, and only
 * its hash is kept), and nothing is booked or charged again. An attempt still
 * on its way is asked to wait; one that did not go through, or that was for
 * something else, is over, and the screen starts a new one.
 */
async function answerAgain(db: Db, requestKey: string, input: ParsedInput): Promise<CreateBookingResult | null> {
  const [earlier] = await db.select().from(bookings).where(eq(bookings.requestKey, requestKey)).limit(1);
  if (!earlier) return null;
  const studios = await db.select({ studioId: studioHolds.studioId }).from(studioHolds).where(eq(studioHolds.bookingId, earlier.id));
  const same =
    earlier.startAt.getTime() === localToUtc(input.date, input.startMinute).getTime() &&
    earlier.durationMinutes === input.durationMinutes &&
    [...new Set(studios.map((row) => row.studioId))].sort().join() === [...input.studioIds].sort().join();
  if (!same) return fail(409, "attempt_over", "Something went wrong. Please press the button again.");
  if (earlier.status === "pending_payment") {
    return fail(409, "in_progress", "Your booking is still being made. Wait a moment, then press the button again: your card is not charged twice.");
  }
  if (earlier.status === "confirmed" || earlier.status === "completed") {
    const manageToken = randomBytes(24).toString("base64url");
    await db.update(bookings).set({ retryTokenHash: hashToken(manageToken) }).where(eq(bookings.id, earlier.id));
    return { ok: true, ref: earlier.ref, manageToken, totalCents: earlier.totalCents };
  }
  // A booking that was not made never charged its card: what it reserved is given back (`createBooking`).
  if (earlier.status === "expired") {
    return fail(
      409,
      "attempt_over",
      `That attempt did not make a booking, and your card was not charged. If an amount appears as held on your card, it is released by itself within ${RESERVE_HOURS} hours. Please try again.`,
    );
  }
  return fail(409, "attempt_over", "That booking was made, and has been cancelled since. Please try again.");
}

const NO_SUCH_SESSION = "That photography session is not offered. Please choose a studio and a length from the list.";

/** The photography package for one studio and one length, if it is on sale. */
function photoPackageFor(catalog: Catalog, studioIds: string[], durationMinutes: number): CatalogPhotoPackage | null {
  if (studioIds.length !== 1) return null;
  return catalog.photoPackages.find((p) => p.studioId === studioIds[0] && p.durationMinutes === durationMinutes) ?? null;
}

// ── Price preview ────────────────────────────────────────────────────────────

export const quoteInput = z.object({
  studioIds: z.array(z.uuid()).min(1).max(10),
  date: z.string().max(10),
  durationMinutes: z.number().int().positive().max(1440),
  addons: addonsField,
  promoCode: textField(0, 40).optional(),
  email: emailField.optional(),
  photography: z.boolean().default(false),
});

export type QuoteResult =
  | {
      ok: true;
      quote: Quote;
      promo: Pick<UsablePromo, "code" | "kind" | "value" | "source" | "photographyOnly"> | null;
      /**
       * A membership's code: what is left on it, whether weekends pay the difference, and the studios its plan is for,
       * for the screen's own price (which drops the hours when other studios are chosen afterwards).
       */
      membership: { code: string; minutesLeft: number; weekendDifference: boolean; studioIds: string[]; studioNames: string[] } | null;
    }
  | { ok: false; status: number; code: "invalid_input" | "invalid_price" | "invalid_code"; message: string };

/**
 * The server's price for a selection, including a code. Used by the booking
 * screen to check a code before the customer pays. Changes nothing.
 */
export async function quoteSelection(db: DbLike, rawInput: unknown, now: Date, processor?: string | null): Promise<QuoteResult> {
  const parsed = quoteInput.safeParse(rawInput);
  if (!parsed.success) return fail(400, "invalid_input", firstIssue(parsed.error));
  const input = parsed.data;
  if (!isIsoDate(input.date)) return fail(400, "invalid_input", "That date is not valid.");

  const catalog = await loadCatalog(db);
  const combinationError = studioCombinationError(catalog.studios, input.studioIds);
  if (combinationError) return fail(422, "invalid_price", combinationError);
  let promo: UsablePromo | null = null;
  let member: UsableMembership | null = null;
  if (input.promoCode && isMembershipCode(input.promoCode)) {
    if (!input.email) return fail(422, "invalid_code", "Enter your email address first, then apply the code.");
    const found = await findUsableMembership(db, input.promoCode, input.email, { studioIds: input.studioIds, photography: input.photography });
    if (!found.ok) return fail(422, "invalid_code", found.message);
    member = found.membership;
    if (processor !== undefined) {
      const kind = await moneyKindNow(db, processor);
      if (moneyKindOf(member.provider) !== kind) return fail(422, "invalid_code", OTHER_MONEY_CODE[kind]);
    }
  } else if (input.promoCode) {
    if (!input.email) return fail(422, "invalid_code", "Enter your email address first, then apply the code.");
    const found = await findUsablePromo(db, input.promoCode, input.email, now);
    if (!found.ok) return fail(422, "invalid_code", PROMO_PROBLEM_TEXT[found.problem]);
    promo = found.promo;
    // As the booking itself refuses it: a code of the other kind of money than a booking made now would be.
    if (processor !== undefined) {
      const [behind, kind] = [await moneyKindOfCode(db, promo.id), await moneyKindNow(db, processor)];
      if (behind !== null && behind !== kind) return fail(422, "invalid_code", OTHER_MONEY_CODE[kind]);
    }
  }
  const membership = member ? { minutesLeft: member.minutesLeft, weekendDifference: catalog.settings.memberWeekendDifference } : null;
  const session = input.photography ? photoPackageFor(catalog, input.studioIds, input.durationMinutes) : null;
  if (input.photography && !session) return fail(422, "invalid_price", NO_SUCH_SESSION);
  try {
    const price = quote({
      studioIds: input.studioIds,
      dayType: dayTypeFor(catalog, input.date),
      durationMinutes: input.durationMinutes,
      rules: catalog.rules,
      multiStudioPercent: catalog.settings.multiStudioPercent,
      addons: input.addons,
      addonCatalog: catalog.addons,
      extraGuestsAllowed: extraGuestsFor(catalog, input.studioIds),
      promo,
      membership,
      photoPackage: session,
    });
    // A code that exists but cannot be used on this selection is refused with the reason.
    if (price.promoMisfit) return fail(422, "invalid_code", PROMO_MISFIT_TEXT[price.promoMisfit]);
    return {
      ok: true,
      quote: price,
      promo: promo ? { code: promo.code, kind: promo.kind, value: promo.value, source: promo.source, photographyOnly: promo.photographyOnly } : null,
      membership: member && membership ? { code: member.code, ...membership, studioIds: member.studioIds, studioNames: member.studioNames } : null,
    };
  } catch (error) {
    if (error instanceof PricingError) return fail(422, "invalid_price", error.message);
    throw error;
  }
}

// ── Creating a booking ───────────────────────────────────────────────────────

/**
 * Create a booking for a studio or bundle.
 *
 * Order matters:
 *  1. Everything is validated and priced on the server.
 *  2. The slot is held in the database first. An exclusion constraint makes
 *     it impossible for two requests to hold the same studio and time. A code,
 *     if any, is spent in the same transaction.
 *  3. Only then is the card charged, with the booking id as idempotency key.
 *  4. Success confirms the booking; failure releases the slot and the code.
 */
export async function createBooking(db: Db, rawInput: unknown, deps: BookingDeps): Promise<CreateBookingResult> {
  const parsed = bookingInput.safeParse(rawInput);
  if (!parsed.success) return fail(400, "invalid_input", firstIssue(parsed.error));
  const input = parsed.data;
  const { now } = deps;
  if (new Set(input.studioIds).size !== input.studioIds.length) {
    return fail(400, "invalid_input", "A studio was selected twice.");
  }

  await releaseExpiredHolds(db, now);

  // The same attempt sent again, by a screen that got no answer: say what became of it, before anything is checked
  // again (its own booking holds the time now).
  const requestKey = input.requestId ? hashToken(`request:${input.requestId.toLowerCase()}`) : null;
  if (requestKey && !deps.madeBy) {
    const again = await answerAgain(db, requestKey, input);
    if (again) return again;
  }

  const catalog = await loadCatalog(db);

  const chosen = input.studioIds.map((id) => catalog.studios.find((s) => s.id === id));
  if (chosen.some((s) => !s)) return fail(400, "unknown_studio", "One of the selected studios is not available.");
  const combinationError = studioCombinationError(catalog.studios, input.studioIds);
  if (combinationError) return fail(422, "invalid_price", combinationError);
  const studioNames = chosen.map((s) => s!.name).join(" + ");

  // A photography session: its package, and the photographer's day beside the studio's.
  const session = input.photography ? photoPackageFor(catalog, input.studioIds, input.durationMinutes) : null;
  if (input.photography && !session) return fail(422, "invalid_price", NO_SUCH_SESSION);

  const day = await loadDayAvailability(db, catalog, input.date, now, {
    asAdmin: Boolean(deps.madeBy),
    withPhotographer: Boolean(session),
  });
  if (day.problem) {
    const text = {
      invalid_date: "That date is not valid.",
      past: "That date has already passed.",
      too_far: `Bookings open ${count(catalog.settings.maxAdvanceDays, "day")} ahead.`,
    }[day.problem];
    return fail(400, "not_bookable_date", text);
  }

  // The kind of money this booking is (src/server/test-mode.ts): the card processor's, and for a booking it does not
  // charge (one made in the admin), that of the processor set up now.
  const moneyKind = await moneyKindNow(db, deps.processor !== undefined ? deps.processor : (deps.payments?.name ?? null));

  let promo: UsablePromo | null = null;
  let member: UsableMembership | null = null;
  if (input.promoCode && isMembershipCode(input.promoCode)) {
    const found = await findUsableMembership(db, input.promoCode, input.customer.email, { studioIds: input.studioIds, photography: input.photography });
    if (!found.ok) return fail(422, "invalid_code", found.message);
    member = found.membership;
    // A membership bought in test mode does not pay for a real booking, nor a real one for a pretend booking.
    if (moneyKindOf(member.provider) !== moneyKind) return fail(422, "invalid_code", OTHER_MONEY_CODE[moneyKind]);
  } else if (input.promoCode) {
    const found = await findUsablePromo(db, input.promoCode, input.customer.email, now);
    if (!found.ok) return fail(422, "invalid_code", PROMO_PROBLEM_TEXT[found.problem]);
    promo = found.promo;
    // Test mode's credit does not pay for a real booking, nor real credit for a pretend one.
    const behind = await moneyKindOfCode(db, promo.id);
    if (behind !== null && behind !== moneyKind) return fail(422, "invalid_code", OTHER_MONEY_CODE[moneyKind]);
  }

  let price: Quote;
  try {
    price = quote({
      studioIds: input.studioIds,
      dayType: day.dayType,
      durationMinutes: input.durationMinutes,
      rules: catalog.rules,
      multiStudioPercent: catalog.settings.multiStudioPercent,
      addons: input.addons,
      addonCatalog: catalog.addons,
      extraGuestsAllowed: extraGuestsFor(catalog, input.studioIds),
      promo,
      membership: member ? { minutesLeft: member.minutesLeft, weekendDifference: catalog.settings.memberWeekendDifference } : null,
      photoPackage: session,
    });
  } catch (error) {
    if (error instanceof PricingError) return fail(422, "invalid_price", error.message);
    throw error;
  }
  const spendsMinutes = member !== null && price.membershipMinutes > 0;
  // The booking screen leaves out a code that does not fit the selection. Anything else that
  // sends one is told why, instead of being charged the full price without a word.
  if (price.promoMisfit) return fail(422, "invalid_code", PROMO_MISFIT_TEXT[price.promoMisfit]);
  if (input.expectedTotalCents !== undefined && input.expectedTotalCents !== price.totalCents) {
    return fail(409, "price_changed", `The price is now ${formatCents(price.totalCents)}. Please review and confirm again.`);
  }

  // Too close to now: said in so many words, because "no longer available" would send the customer
  // looking for another time on a day that has none. An administrator gives no notice.
  if (input.startMinute < day.earliestStartMinute) {
    const notice = hoursInWords(noticeHours(catalog.settings, Boolean(session)));
    return fail(
      409,
      "slot_taken",
      `${session ? "Photography sessions" : "Bookings"} are made at least ${notice} ahead. Please choose a later ${session ? "date" : "time"}.`,
    );
  }

  const slot = {
    durationMinutes: input.durationMinutes,
    incrementMinutes: catalog.settings.slotIncrementMinutes,
    earliestStartMinute: day.earliestStartMinute,
  };
  const allFree = input.studioIds.every((id) => {
    const studioDay = day.days.find((d) => d.studioId === id);
    return studioDay !== undefined && isStartFree(studioDay, input.startMinute, slot);
  });
  if (!allFree) return fail(409, "slot_taken", "That time is no longer available. Please choose another.");
  // The photographer has to be free as well: inside their working hours, and not at another session or blocked.
  const photographer = session ? (day.photographer ?? null) : null;
  if (session && !photographer) {
    return fail(409, "slot_taken", "Photography sessions cannot be booked online right now. Please contact the studio.");
  }
  if (photographer && !isStartFree(photographer, input.startMinute, slot)) {
    return fail(409, "slot_taken", "Our photographer is not free at that time. Please choose another.");
  }

  const chargesCard = price.totalCents > 0 && !deps.madeBy;
  if (chargesCard) {
    if (!deps.payments) {
      return fail(503, "payments_unavailable", "Online payment is not available right now. Please contact the studio.");
    }
    if (!input.paymentToken) return fail(400, "payment_required", "Card details are required.");
  }
  const booked = deps.madeBy
    ? { actor: deps.madeBy, note: "Booked in the admin for the client" }
    : { actor: BY_CUSTOMER, note: "Booked online" };

  const startAt = localToUtc(input.date, input.startMinute);
  const endAt = localToUtc(input.date, input.startMinute + input.durationMinutes);
  // Across the hour the clocks change, a booking would not last as long as it costs. The day's taken time
  // already holds that hour (`clockChangeOn`); this is the last word.
  if (endAt.getTime() - startAt.getTime() !== input.durationMinutes * 60_000) {
    return fail(409, "slot_taken", "The clocks change at that time, so it cannot be booked. Please choose another.");
  }
  const manageToken = randomBytes(24).toString("base64url");
  const holdExpiresAt = new Date(now.getTime() + catalog.settings.holdMinutes * 60_000);
  const spendsCode = promo !== null && price.promoDiscountCents > 0;

  // ── Hold the slot ──────────────────────────────────────────────────────────
  let bookingId = "";
  let ref = "";
  for (let attempt = 0; ; attempt++) {
    ref = newRef();
    try {
      bookingId = await db.transaction(async (tx) => {
        if (spendsCode && !(await redeemPromo(tx, promo!, price.promoDiscountCents, now))) throw new PromoGone();

        const [row] = await tx
          .insert(bookings)
          .values({
            ref,
            customerName: input.customer.name,
            customerEmail: input.customer.email,
            customerPhone: input.customer.phone,
            notes: input.notes,
            startAt,
            endAt,
            durationMinutes: input.durationMinutes,
            status: "pending_payment",
            holdExpiresAt,
            studiosSubtotalCents: price.studiosSubtotalCents,
            multiStudioDiscountCents: price.multiStudioDiscountCents,
            addonsCents: price.addonsCents,
            promoDiscountCents: price.promoDiscountCents,
            totalCents: price.totalCents,
            promoCodeId: spendsCode ? promo!.id : null,
            creditAppliedCents: spendsCode && promo!.kind === "amount" ? price.promoDiscountCents : 0,
            membershipId: spendsMinutes ? member!.id : null,
            membershipMinutes: spendsMinutes ? price.membershipMinutes : 0,
            membershipCents: spendsMinutes ? price.membershipCents : 0,
            // The kind of day it is priced as, which a move by the studio compares the new day with (follow-up 5).
            pricedAs: day.dayType,
            // Money that was already moved once stays "moved" on the new booking.
            rescheduledCount: spendsCode && promo!.source === "reschedule" ? promo!.rescheduleGeneration : 0,
            manageTokenHash: hashToken(manageToken),
            requestKey: deps.madeBy ? null : requestKey,
            moneyKind,
            photographerId: photographer ? photographer.studioId : null,
            photoIncludes: session ? session.includes : null,
            madeBy: deps.madeBy ?? null,
            // The client has not ticked the box themselves when an administrator books for them.
            termsAcceptedAt: deps.madeBy ? null : now,
            // The terms in effect now stay with the booking when the owners change them later (question 10).
            terms: termsAtBooking(catalog.settings, session !== null),
            createdAt: now,
          })
          .returning({ id: bookings.id });
        if (spendsMinutes && !(await takeBookingMinutes(tx, { membershipId: member!.id, bookingId: row.id, minutes: price.membershipMinutes, ref }))) {
          throw new MinutesGone();
        }

        // Always take studios in the same order, so two multi-studio bookings
        // that overlap can never wait on each other in a cycle.
        const ordered = [...price.studioLines].sort((a, b) => (a.studioId < b.studioId ? -1 : 1));
        for (const line of ordered) {
          const studio = catalog.studios.find((s) => s.id === line.studioId)!;
          const occupiedEnd = new Date(endAt.getTime() + studio.bufferMinutes * 60_000);
          await tx.insert(studioHolds).values({
            studioId: line.studioId,
            bookingId: row.id,
            priceCents: line.priceCents,
            occupied: sql`tstzrange(${startAt.toISOString()}::timestamptz, ${occupiedEnd.toISOString()}::timestamptz, '[)')`,
          });
        }
        if (photographer) {
          // The photographer is held for the session and for the gap after it. The database refuses a
          // second hold of the same photographer for an overlapping time, whatever the studio.
          const heldUntil = new Date(endAt.getTime() + photographer.bufferMinutes * 60_000);
          await tx.insert(photographerHolds).values({
            photographerId: photographer.studioId,
            bookingId: row.id,
            occupied: sql`tstzrange(${startAt.toISOString()}::timestamptz, ${heldUntil.toISOString()}::timestamptz, '[)')`,
          });
        }
        if (price.addonLines.length > 0) {
          await tx.insert(bookingAddons).values(
            price.addonLines.map((line) => ({
              bookingId: row.id,
              addonId: line.addonId,
              name: line.name,
              quantity: line.quantity,
              unitCents: line.unitCents,
              // What the add-on is for today stays with the booking: the pet fee has a refund rule of its own.
              kind: catalog.addons.find((addon) => addon.id === line.addonId)?.kind ?? "other",
            })),
          );
        }
        return row.id;
      });
      break;
    } catch (error) {
      if (error instanceof PromoGone) {
        return fail(409, "invalid_code", "That code was just used. Please remove it and try again.");
      }
      if (error instanceof MinutesGone) {
        return fail(409, "invalid_code", "The hours left on your membership changed meanwhile. Please apply the code again to see the price.");
      }
      const code = pgErrorCode(error);
      if (code === PG_EXCLUSION_VIOLATION || code === PG_DEADLOCK_DETECTED) {
        return fail(409, "slot_taken", "That time was just taken. Please choose another.");
      }
      // The same attempt arriving twice at once: the second finds the first on its way.
      if (code === PG_UNIQUE_VIOLATION && requestKey && !deps.madeBy) {
        const again = await answerAgain(db, requestKey, input);
        if (again) return again;
      }
      if (code === PG_UNIQUE_VIOLATION && attempt < 5) continue; // booking reference collision
      throw error;
    }
  }

  // ── Pay by card: reserve the amount, confirm the booking, then take the amount (src/server/reserved.ts) ──
  if (chargesCard) {
    const provider = deps.payments!;
    const [payment] = await db
      .insert(payments)
      .values({ bookingId, provider: provider.name, amountCents: price.totalCents, status: "pending", createdAt: now })
      .returning({ id: payments.id });

    const charge = await provider.charge({
      amountCents: price.totalCents,
      token: input.paymentToken!,
      idempotencyKey: bookingId,
      reference: ref,
      note: `${ref} ${studioNames}, ${input.customer.name}`,
      buyerEmail: input.customer.email,
      reserve: true,
    });

    if (!charge.ok) {
      await db.transaction(async (tx) => {
        await tx
          .update(payments)
          .set({ status: "failed", error: charge.detail ?? charge.message })
          .where(eq(payments.id, payment.id));
        // Only the attempt that ends the hold gives the code back: a hold that ran out meanwhile gave it back already.
        const [ended] = await tx
          .update(bookings)
          .set({ status: "expired" })
          .where(and(eq(bookings.id, bookingId), eq(bookings.status, "pending_payment")))
          .returning({ id: bookings.id });
        if (!ended) return;
        await releaseHolds(tx, bookingId);
        if (spendsCode) await restorePromo(tx, promo!.id, promo!.kind, price.promoDiscountCents);
        await giveBackUnmadeMinutes(tx, [bookingId]);
      });
      return fail(
        402,
        "payment_failed",
        // No answer: an amount may have been reserved, but nothing was taken, and the processor gives it back by itself.
        charge.unknown
          ? `${charge.message} Your booking was not made, and your card was not charged. If an amount appears as held on your card, it is released by itself within ${RESERVE_HOURS} hours.`
          : `Payment failed: ${charge.message} Your card was not charged.`,
      );
    }

    const stands = await db.transaction(async (tx) => {
      await tx
        .update(payments)
        .set({ status: "authorized", providerPaymentId: charge.paymentId })
        .where(eq(payments.id, payment.id));
      const [confirmed] = await tx
        .update(bookings)
        .set({ status: "confirmed", holdExpiresAt: null })
        .where(and(eq(bookings.id, bookingId), eq(bookings.status, "pending_payment")))
        .returning({ id: bookings.id });
      if (!confirmed) return false;
      await recordEvent(tx, { bookingId, from: "new", to: "confirmed", at: now, ...booked });
      return true;
    });
    if (!stands) {
      // The hold on the time ran out while the card was answering, and the time was given up (with the code): nothing
      // is booked, and what was reserved goes back. Should the processor not answer now, the scheduled task tries again.
      await giveBackReserved(db, { id: payment.id, providerPaymentId: charge.paymentId }, provider);
      return fail(
        409,
        "slot_taken",
        `That took too long, and the time was given up. Your booking was not made, and your card was not charged. If an amount appears as held on your card, it is released by itself within ${RESERVE_HOURS} hours. Please choose a time again.`,
      );
    }
    // The booking stands now. Taking the money that does not go through is tried again by the scheduled task.
    await takeReserved(
      db,
      { id: payment.id, providerPaymentId: charge.paymentId, amountCents: price.totalCents, error: null, ref, customer: input.customer.name, createdAt: now },
      { now, payments: provider, ownerEmail: deps.ownerEmail ?? null },
    );
  } else {
    await db.transaction(async (tx) => {
      await tx.update(bookings).set({ status: "confirmed", holdExpiresAt: null }).where(eq(bookings.id, bookingId));
      await recordEvent(tx, { bookingId, from: "new", to: "confirmed", at: now, ...booked });
    });
  }

  // ── Confirmation email (queued; a failure here never undoes the booking) ──
  try {
    await queueEmail(
      db,
      bookingConfirmationEmail({
        to: input.customer.email,
        name: input.customer.name,
        ref,
        studios: studioNames,
        when: formatInstant(startAt),
        duration: durationLabel(input.durationMinutes),
        totalCents: price.totalCents + (spendsCode && promo!.kind === "amount" ? price.promoDiscountCents : 0) + price.membershipCents,
        creditCents: spendsCode && promo!.kind === "amount" ? price.promoDiscountCents : price.membershipCents,
        creditName: spendsMinutes ? `membership hours (${durationLabel(price.membershipMinutes)})` : promo ? creditName(promo.source) : undefined,
        cardCents: price.totalCents,
        // A booking the studio made is paid at the studio, whatever a code or membership hours left to pay: no card is charged.
        payAtStudio: Boolean(deps.madeBy),
        photoIncludes: session ? session.includes : undefined,
        manageUrl: manageUrl(deps.baseUrl, ref, manageToken),
        access: await loadAccessInstructions(db),
      }),
    );
  } catch (error) {
    console.error("Could not queue confirmation email for", ref, error);
  }

  return { ok: true, ref, manageToken, totalCents: price.totalCents };
}

export function manageUrl(baseUrl: string, ref: string, token: string): string {
  return `${baseUrl.replace(/\/$/, "")}/booking/${ref}?t=${encodeURIComponent(token)}`;
}

// ── Reading bookings ─────────────────────────────────────────────────────────

export interface BookingView {
  id: string;
  ref: string;
  status: string;
  cancelReason: string | null;
  customerName: string;
  customerEmail: string;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  studios: { name: string; priceCents: number }[];
  addons: { name: string; quantity: number; unitCents: number }[];
  studiosSubtotalCents: number;
  multiStudioDiscountCents: number;
  addonsCents: number;
  promoDiscountCents: number;
  creditAppliedCents: number;
  /** The kind of code used on the booking, if any. */
  promoKind: PromoKind | null;
  /** Where that code came from: a moved booking, the loyalty reward, the studio, or a pet fee returned. */
  promoSource: PromoSource | null;
  /** Membership minutes the booking took, and the part of the studio price they paid (follow-up 3). */
  membershipMinutes: number;
  membershipCents: number;
  /** The status label an administrator sees. */
  label: LabelKey;
  /** Made in the admin for the client: nothing was charged online, the total is paid at the studio. */
  madeByAdmin: boolean;
  /** Set on a photography session: what it includes, as it was sold. */
  photography: { includes: string } | null;
  totalCents: number;
  /** Extra charges added once the appointment started (overtime, cleaning, damage), not taken back: src/server/charges.ts. */
  charges: { label: string; cents: number }[];
  /** Their sum: the booking costs `totalCents` and this. */
  chargesCents: number;
  /** Money received for the booking so far, by card through the site or at the studio, before any refund. */
  receivedCents: number;
  /** The part of it taken at the studio and recorded by hand; the rest came by card (online, or through a payment link). */
  receivedAtStudioCents: number;
  /** What was given back of what it was paid beyond its price (follow-up 5): `receivedCents` less this was paid toward it. */
  creditReturnedCents: number;
  /**
   * What is still to pay (`owedCents` in money.ts): until it is paid for a
   * booking made in the admin; for one made online, only once the amount its
   * card held lapsed before it was taken. Nothing for a booking that ended.
   */
  dueCents: number;
  /** What the card holds reserved for the booking, not taken yet (`heldCentsByBooking` in money.ts). */
  heldCents: number;
  /**
   * What was paid beyond what the booking costs now (`creditLeftCentsByBooking` in money.ts): after a move to a day
   * that costs less, until the studio refunds it. Nothing for a booking that ended.
   */
  creditLeftCents: number;
  rescheduledCount: number;
}

type BookingRow = typeof bookings.$inferSelect;

/** Attach studios and add-ons to booking rows, keeping their order. */
export async function toBookingViews(db: DbLike, rows: BookingRow[], now: Date = new Date()): Promise<BookingView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const codeIds = rows.map((r) => r.promoCodeId).filter((id): id is string => id !== null);
  const [holdRows, addonRows, codeRows, received, atStudio, owed, held, charged, creditLeft, creditReturned] = await together(db, [
    () => db
      .select({ bookingId: studioHolds.bookingId, name: studios.name, priceCents: studioHolds.priceCents, sort: studios.sortOrder })
      .from(studioHolds)
      .innerJoin(studios, eq(studios.id, studioHolds.studioId))
      .where(inArray(studioHolds.bookingId, ids)),
    () => db.select().from(bookingAddons).where(inArray(bookingAddons.bookingId, ids)),
    () => codeIds.length > 0
      ? db
          .select({ id: promoCodes.id, kind: promoCodes.kind, source: promoCodes.source })
          .from(promoCodes)
          .where(inArray(promoCodes.id, codeIds))
      : [],
    () => receivedCentsByBooking(db, ids),
    () => receivedCentsByBooking(db, ids, "at_studio"),
    () => owedCentsByBooking(db, rows, now),
    () => heldCentsByBooking(db, ids, now),
    () => activeChargesByBooking(db, ids),
    () => creditLeftCentsByBooking(db, rows),
    () => creditReturnedCentsByBooking(db, ids),
  ]);
  return rows.map((booking) => ({
    id: booking.id,
    ref: booking.ref,
    status: booking.status,
    cancelReason: booking.cancelReason,
    customerName: booking.customerName,
    customerEmail: booking.customerEmail,
    startAt: booking.startAt.toISOString(),
    endAt: booking.endAt.toISOString(),
    durationMinutes: booking.durationMinutes,
    studios: holdRows
      .filter((h) => h.bookingId === booking.id)
      .sort((a, b) => a.sort - b.sort)
      .map((h) => ({ name: h.name, priceCents: h.priceCents })),
    addons: addonRows
      .filter((a) => a.bookingId === booking.id)
      .map((a) => ({ name: a.name, quantity: a.quantity, unitCents: a.unitCents })),
    studiosSubtotalCents: booking.studiosSubtotalCents,
    multiStudioDiscountCents: booking.multiStudioDiscountCents,
    addonsCents: booking.addonsCents,
    promoDiscountCents: booking.promoDiscountCents,
    creditAppliedCents: booking.creditAppliedCents,
    promoKind: codeRows.find((code) => code.id === booking.promoCodeId)?.kind ?? null,
    promoSource: codeRows.find((code) => code.id === booking.promoCodeId)?.source ?? null,
    membershipMinutes: booking.membershipMinutes,
    membershipCents: booking.membershipCents,
    label: labelOf(booking),
    madeByAdmin: booking.madeBy !== null,
    photography: booking.photographerId !== null ? { includes: booking.photoIncludes ?? "" } : null,
    totalCents: booking.totalCents,
    charges: charged.get(booking.id) ?? [],
    chargesCents: (charged.get(booking.id) ?? []).reduce((sum, charge) => sum + charge.cents, 0),
    receivedCents: received.get(booking.id) ?? 0,
    receivedAtStudioCents: atStudio.get(booking.id) ?? 0,
    creditReturnedCents: creditReturned.get(booking.id) ?? 0,
    dueCents: owed.get(booking.id) ?? 0,
    heldCents: held.get(booking.id) ?? 0,
    creditLeftCents: creditLeft.get(booking.id) ?? 0,
    rescheduledCount: booking.rescheduledCount,
  }));
}

/**
 * True for a confirmed booking whose time has not ended. Only then is its
 * holder told how to get into the building. The end time is part of the test
 * because a booking stays "confirmed" after the visit until the scheduled task
 * marks it completed: without it, an earlier visitor's link would go on
 * showing the text, including a door code set after their visit.
 */
export function isUpcomingVisit(booking: Pick<BookingView, "status" | "endAt">, now: Date): boolean {
  return booking.status === "confirmed" && now.getTime() < new Date(booking.endAt).getTime();
}

/**
 * True when `token` is the secret from this booking's manage link: the one in
 * its confirmation email, or the second one given to a screen that asked
 * again for the booking it had made (`answerAgain`).
 */
export function tokenMatches(booking: Pick<BookingRow, "manageTokenHash" | "retryTokenHash">, token: string): boolean {
  if (token.length < 16 || token.length > 200) return false;
  const given = Buffer.from(hashToken(token), "hex");
  const matches = (hash: string | null) => {
    const expected = Buffer.from(hash ?? "", "hex");
    return expected.length === given.length && expected.length > 0 && timingSafeEqual(expected, given);
  };
  // Both are compared every time, so the time taken does not tell which one matched.
  const first = matches(booking.manageTokenHash);
  const second = matches(booking.retryTokenHash);
  return first || second;
}

export function isBookingRef(value: string): boolean {
  return /^VS-[0-9A-Z]{6}$/.test(value);
}

/** A booking as its customer may see it. Requires the secret from their link. */
export async function getBookingByToken(db: DbLike, ref: string, token: string): Promise<BookingView | null> {
  if (!isBookingRef(ref)) return null;
  const [booking] = await db.select().from(bookings).where(eq(bookings.ref, ref)).limit(1);
  if (!booking || !tokenMatches(booking, token)) return null;
  return (await toBookingViews(db, [booking]))[0];
}

/** Every booking made with an email address, newest first. For the signed-in customer. */
export async function listBookingsForEmail(db: DbLike, email: string): Promise<BookingView[]> {
  const rows = await db
    .select()
    .from(bookings)
    .where(eq(bookings.customerEmail, email.trim().toLowerCase()))
    .orderBy(desc(bookings.startAt))
    .limit(200);
  // Abandoned checkouts are not bookings the customer needs to see.
  return toBookingViews(
    db,
    rows.filter((r) => r.status !== "expired" && r.status !== "pending_payment"),
  );
}
