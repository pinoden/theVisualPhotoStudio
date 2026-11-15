import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { desc, eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { bookingAddons, bookings, payments, promoCodes, studioHolds, studios } from "@/db/schema";
import {
  PG_DEADLOCK_DETECTED,
  PG_EXCLUSION_VIOLATION,
  PG_UNIQUE_VIOLATION,
  pgErrorCode,
  type Db,
  type DbLike,
} from "@/db/client";
import { isStartFree } from "@/lib/domain/availability";
import { formatCents, PricingError, PROMO_MISFIT_TEXT, quote, type PromoKind, type Quote } from "@/lib/domain/pricing";
import { formText } from "@/lib/parse";
import { count } from "@/lib/words";
import { durationLabel, isIsoDate } from "@/lib/domain/time";
import { loadDayAvailability, releaseExpiredHolds } from "./availability";
import { dayTypeFor, loadCatalog } from "./catalog";
import { bookingConfirmationEmail, ownerPaymentUnknownNotice, queueEmail } from "./email";
import type { PaymentProvider } from "./payments";
import { findUsablePromo, PROMO_PROBLEM_TEXT, redeemPromo, restorePromo, toPromoDef, type UsablePromo } from "./promos";
import { loadAccessInstructions } from "./settings";
import { formatInstant, localToUtc } from "./tz";

const emailField = z.string().trim().toLowerCase().max(200).pipe(z.email());
/** Text a person typed: trimmed, line breaks made single, and without the NUL character the database refuses. */
const textField = (min: number, max: number) => z.string().transform(formText).pipe(z.string().min(min).max(max));
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
  /** A loyalty or reschedule code. */
  promoCode: textField(0, 40).optional(),
  acceptTerms: z.literal(true),
  paymentToken: z.string().min(1).max(1000).optional(),
  /** The total the customer was shown. A mismatch stops the booking before any charge. */
  expectedTotalCents: z.number().int().nonnegative().optional(),
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
  | "payment_failed";

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
}

const REF_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function newRef(): string {
  let out = "VS-";
  for (let i = 0; i < 6; i++) out += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return out;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function fail<T extends string>(status: number, code: T, message: string) {
  return { ok: false as const, status, code, message };
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const field = issue?.path.join(".") || "request";
  return `Please check ${field}: ${issue?.message ?? "invalid value"}.`;
}

/** Raised inside the booking transaction when the code was spent by another request. */
class PromoGone extends Error {}

// ── Price preview ────────────────────────────────────────────────────────────

export const quoteInput = z.object({
  studioIds: z.array(z.uuid()).min(1).max(10),
  date: z.string().max(10),
  durationMinutes: z.number().int().positive().max(1440),
  addons: addonsField,
  promoCode: textField(0, 40).optional(),
  email: emailField.optional(),
});

export type QuoteResult =
  | { ok: true; quote: Quote; promo: { code: string; kind: PromoKind; value: number } | null }
  | { ok: false; status: number; code: "invalid_input" | "invalid_price" | "invalid_code"; message: string };

/**
 * The server's price for a selection, including a code. Used by the booking
 * screen to check a code before the customer pays. Changes nothing.
 */
export async function quoteSelection(db: DbLike, rawInput: unknown, now: Date): Promise<QuoteResult> {
  const parsed = quoteInput.safeParse(rawInput);
  if (!parsed.success) return fail(400, "invalid_input", firstIssue(parsed.error));
  const input = parsed.data;
  if (!isIsoDate(input.date)) return fail(400, "invalid_input", "That date is not valid.");

  const catalog = await loadCatalog(db);
  let promo: UsablePromo | null = null;
  if (input.promoCode) {
    if (!input.email) return fail(422, "invalid_code", "Enter your email address first, then apply the code.");
    const found = await findUsablePromo(db, input.promoCode, input.email, now);
    if (!found.ok) return fail(422, "invalid_code", PROMO_PROBLEM_TEXT[found.problem]);
    promo = found.promo;
  }
  try {
    const price = quote({
      studioIds: input.studioIds,
      dayType: dayTypeFor(catalog, input.date),
      durationMinutes: input.durationMinutes,
      rules: catalog.rules,
      multiStudioPercent: catalog.settings.multiStudioPercent,
      addons: input.addons,
      addonCatalog: catalog.addons,
      promo: promo ? toPromoDef(promo) : null,
    });
    // A code that exists but cannot be used on this selection is refused with the reason.
    if (price.promoMisfit) return fail(422, "invalid_code", PROMO_MISFIT_TEXT[price.promoMisfit]);
    return { ok: true, quote: price, promo: promo ? { code: promo.code, kind: promo.kind, value: promo.value } : null };
  } catch (error) {
    if (error instanceof PricingError) return fail(422, "invalid_price", error.message);
    throw error;
  }
}

// ── Creating a booking ───────────────────────────────────────────────────────

/**
 * Create a booking for any set of studios.
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
  const catalog = await loadCatalog(db);

  const chosen = input.studioIds.map((id) => catalog.studios.find((s) => s.id === id));
  if (chosen.some((s) => !s)) return fail(400, "unknown_studio", "One of the selected studios is not available.");
  const studioNames = chosen.map((s) => s!.name).join(" + ");

  const day = await loadDayAvailability(db, catalog, input.date, now);
  if (day.problem) {
    const text = {
      invalid_date: "That date is not valid.",
      past: "That date has already passed.",
      too_far: `Bookings open ${count(catalog.settings.maxAdvanceDays, "day")} ahead.`,
    }[day.problem];
    return fail(400, "not_bookable_date", text);
  }

  let promo: UsablePromo | null = null;
  if (input.promoCode) {
    const found = await findUsablePromo(db, input.promoCode, input.customer.email, now);
    if (!found.ok) return fail(422, "invalid_code", PROMO_PROBLEM_TEXT[found.problem]);
    promo = found.promo;
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
      promo: promo ? toPromoDef(promo) : null,
    });
  } catch (error) {
    if (error instanceof PricingError) return fail(422, "invalid_price", error.message);
    throw error;
  }
  // The booking screen leaves out a code that does not fit the selection. Anything else that
  // sends one is told why, instead of being charged the full price without a word.
  if (price.promoMisfit) return fail(422, "invalid_code", PROMO_MISFIT_TEXT[price.promoMisfit]);
  if (input.expectedTotalCents !== undefined && input.expectedTotalCents !== price.totalCents) {
    return fail(409, "price_changed", `The price is now ${formatCents(price.totalCents)}. Please review and confirm again.`);
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

  if (price.totalCents > 0) {
    if (!deps.payments) {
      return fail(503, "payments_unavailable", "Online payment is not available right now. Please contact the studio.");
    }
    if (!input.paymentToken) return fail(400, "payment_required", "Card details are required.");
  }

  const startAt = localToUtc(input.date, input.startMinute);
  const endAt = localToUtc(input.date, input.startMinute + input.durationMinutes);
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
            // Money that was already moved once stays "moved" on the new booking.
            rescheduledCount: spendsCode && promo!.source === "reschedule" ? promo!.rescheduleGeneration : 0,
            manageTokenHash: hashToken(manageToken),
            termsAcceptedAt: now,
            createdAt: now,
          })
          .returning({ id: bookings.id });

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
        if (price.addonLines.length > 0) {
          await tx.insert(bookingAddons).values(
            price.addonLines.map((line) => ({
              bookingId: row.id,
              addonId: line.addonId,
              name: line.name,
              quantity: line.quantity,
              unitCents: line.unitCents,
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
      const code = pgErrorCode(error);
      if (code === PG_EXCLUSION_VIOLATION || code === PG_DEADLOCK_DETECTED) {
        return fail(409, "slot_taken", "That time was just taken. Please choose another.");
      }
      if (code === PG_UNIQUE_VIOLATION && attempt < 5) continue; // booking reference collision
      throw error;
    }
  }

  // ── Charge the card ────────────────────────────────────────────────────────
  if (price.totalCents > 0) {
    const provider = deps.payments!;
    const [payment] = await db
      .insert(payments)
      .values({ bookingId, provider: provider.name, amountCents: price.totalCents, status: "pending" })
      .returning({ id: payments.id });

    const charge = await provider.charge({
      amountCents: price.totalCents,
      token: input.paymentToken!,
      idempotencyKey: bookingId,
      reference: ref,
      note: `${ref} ${studioNames}, ${input.customer.name}`,
      buyerEmail: input.customer.email,
    });

    if (!charge.ok) {
      await db.transaction(async (tx) => {
        await tx
          .update(payments)
          .set({ status: "failed", error: charge.detail ?? charge.message })
          .where(eq(payments.id, payment.id));
        await tx.update(bookings).set({ status: "expired" }).where(eq(bookings.id, bookingId));
        await tx.update(studioHolds).set({ active: false }).where(eq(studioHolds.bookingId, bookingId));
        if (spendsCode) await restorePromo(tx, promo!.id, promo!.kind, price.promoDiscountCents);
        // No answer from the processor: the card may have been charged, and only a person can check.
        if (charge.unknown && deps.ownerEmail) {
          await queueEmail(
            tx,
            ownerPaymentUnknownNotice({
              to: deps.ownerEmail,
              ref,
              customer: input.customer.name,
              amountCents: price.totalCents,
            }),
          );
        }
      });
      return fail(
        402,
        "payment_failed",
        charge.unknown
          ? `${charge.message} Your booking was not made. We cannot tell whether your card was charged: if a charge appears, contact us and we will refund it.`
          : `Payment failed: ${charge.message} Your card was not charged.`,
      );
    }

    await db.transaction(async (tx) => {
      await tx
        .update(payments)
        .set({ status: "succeeded", providerPaymentId: charge.paymentId })
        .where(eq(payments.id, payment.id));
      await tx.update(bookings).set({ status: "confirmed", holdExpiresAt: null }).where(eq(bookings.id, bookingId));
    });
  } else {
    await db.update(bookings).set({ status: "confirmed", holdExpiresAt: null }).where(eq(bookings.id, bookingId));
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
        totalCents: price.totalCents + (spendsCode && promo!.kind === "amount" ? price.promoDiscountCents : 0),
        creditCents: spendsCode && promo!.kind === "amount" ? price.promoDiscountCents : 0,
        cardCents: price.totalCents,
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
  totalCents: number;
  rescheduledCount: number;
}

type BookingRow = typeof bookings.$inferSelect;

/** Attach studios and add-ons to booking rows, keeping their order. */
export async function toBookingViews(db: DbLike, rows: BookingRow[]): Promise<BookingView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const codeIds = rows.map((r) => r.promoCodeId).filter((id): id is string => id !== null);
  const [holdRows, addonRows, codeRows] = await Promise.all([
    db
      .select({ bookingId: studioHolds.bookingId, name: studios.name, priceCents: studioHolds.priceCents, sort: studios.sortOrder })
      .from(studioHolds)
      .innerJoin(studios, eq(studios.id, studioHolds.studioId))
      .where(inArray(studioHolds.bookingId, ids)),
    db.select().from(bookingAddons).where(inArray(bookingAddons.bookingId, ids)),
    codeIds.length > 0
      ? db.select({ id: promoCodes.id, kind: promoCodes.kind }).from(promoCodes).where(inArray(promoCodes.id, codeIds))
      : [],
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
    totalCents: booking.totalCents,
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

/** True when `token` is the secret from this booking's manage link. */
export function tokenMatches(booking: Pick<BookingRow, "manageTokenHash">, token: string): boolean {
  if (token.length < 16 || token.length > 200) return false;
  const expected = Buffer.from(booking.manageTokenHash, "hex");
  const given = Buffer.from(hashToken(token), "hex");
  return expected.length === given.length && expected.length > 0 && timingSafeEqual(expected, given);
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
