import { eq } from "drizzle-orm";
import { bookingAddons, bookings, promoCodes, studioHolds } from "@/db/schema";
import { together, type DbLike } from "@/db/client";
import { durationLabel, type DayType, type IsoDate } from "@/lib/domain/time";
import { formatCents, PricingError, quote, unpriced, type PromoDef, type Quote } from "@/lib/domain/pricing";
import { dayTypeFor, type Catalog } from "./catalog";
import { creditName, type PromoSource } from "./promos";
import { localDateOf } from "./tz";

type BookingRow = typeof bookings.$inferSelect;

/**
 * What a move to another day does to a booking's price (follow-up 5; how, the builder's reading of question 47).
 *
 * Only a new date or time reprices a booking (the owner's confirmation of 2026-11-17), and a booking's price depends on
 * its day only through the kind of day: a weekday, or a weekend, a special date counting as the kind the owners set. A
 * move to a day of the same kind keeps the price as it is, even when the price list has changed since the booking was
 * made. A move to a day of the other kind prices the booking for that kind, at today's price list, as the booking screen
 * would: its studios and the bundle discount. Its add-ons keep the prices they were booked at, as they are the same any
 * day. What paid for part of it pays the same part again: a percent code takes its percentage of the new price, a free
 * hour is the new day's hour, membership minutes pay for the same minutes at the new day's price, and credit (a
 * reschedule code or studio credit) pays what it paid, up to the new price; what the new price no longer needs of the
 * credit goes back onto its code, as the studio's cancellation gives it back. A photography session's price is the same
 * any day, so it never changes.
 */
export type MovePrice =
  /** The price stays: a day of the same kind, or a photography session. */
  | { kind: "same" }
  | {
      kind: "new";
      /** The new day's kind, which the booking is priced for now. */
      dayType: DayType;
      /** What the booking cost before: its total after codes and minutes. */
      wasCents: number;
      quote: Quote;
      /** Credit the booking takes from its code now: what it took before, up to the new price. 0 for a booking with none. */
      creditAppliedCents: number;
      /** The part of the credit the new price no longer needs: it goes back onto its code. */
      codeBack: { codeId: string; code: string; source: PromoSource; cents: number } | null;
      /**
       * Whether anything the client reads changes: their total, what is left to pay after credit and minutes, or credit
       * back on their code. Not when a free hour or a full discount still pays all of it (the tester's finding of
       * 2026-11-18: "its total is now $0 instead of $0"): the booking's prices change, and nobody is told.
       */
      announced: boolean;
    }
  /** The booking cannot be priced for the new day: no price for its length in one of its studios. */
  | { kind: "refused"; message: string };

/** The total "before" and "after" a move as the client reads it: after discounts, before credit and minutes paid for it. */
export function totalBeforeCredit(amounts: { totalCents: number; creditAppliedCents: number; membershipCents: number }): number {
  return amounts.totalCents + amounts.creditAppliedCents + amounts.membershipCents;
}

const KIND_WORDS: Record<DayType, string> = { weekday: "weekday", weekend: "weekend" };
/** "Priced as a weekday", "priced as a weekend day". */
export const PRICED_AS: Record<DayType, string> = { weekday: "a weekday", weekend: "a weekend day" };

/** The price of `booking` on `date`, which it is being moved to (`MovePrice`). Reads in the caller's transaction. */
export async function priceOnNewDay(db: DbLike, booking: BookingRow, date: IsoDate, catalog: Catalog): Promise<MovePrice> {
  if (booking.photographerId !== null) return { kind: "same" };
  const dayType = dayTypeFor(catalog, date);
  // The kind it is priced as, whatever the owners have made its day since (a special date added later: the tester's
  // finding of 2026-11-18). A booking from before that was kept: its day's kind now.
  if (dayType === (booking.pricedAs ?? dayTypeFor(catalog, localDateOf(booking.startAt)))) return { kind: "same" };

  const codeId = booking.promoCodeId;
  const [holds, addonRows, codeRows] = await together(db, [
    () => db.select({ studioId: studioHolds.studioId, priceCents: studioHolds.priceCents }).from(studioHolds).where(eq(studioHolds.bookingId, booking.id)),
    () => db.select().from(bookingAddons).where(eq(bookingAddons.bookingId, booking.id)),
    () => (codeId ? db.select().from(promoCodes).where(eq(promoCodes.id, codeId)).limit(1) : Promise.resolve([])),
  ]);
  const studioIds = holds.map((hold) => hold.studioId).sort();
  const gap = unpriced(studioIds, dayType, booking.durationMinutes, catalog.rules, catalog.bundlePrices);
  if (gap) {
    const names = gap.studioIds.map((id) => catalog.studios.find((studio) => studio.id === id)?.name ?? "One of its studios").join(" and ");
    // Studios with prices together cost the same on every day, so no other kind of day would help.
    if (gap.together) {
      return { kind: "refused", message: `${names} have no price together for ${durationLabel(booking.durationMinutes)} under Prices, so the booking cannot be priced. Add the price first.` };
    }
    return {
      kind: "refused",
      message: `${names} ${gap.studioIds.length > 1 ? "have" : "has"} no ${KIND_WORDS[dayType]} price for ${durationLabel(booking.durationMinutes)} under Prices, so the booking cannot be priced for that day. Add the price first, or choose a ${KIND_WORDS[dayType === "weekend" ? "weekday" : "weekend"]}.`,
    };
  }

  const [code] = codeRows;
  const credit = booking.creditAppliedCents > 0;
  // A code that has gone (codes are cancelled, never deleted) leaves what it took off as it was.
  if (credit && !code) return { kind: "refused", message: "The code this booking was paid with no longer exists, so its price cannot be worked out again." };
  const promo: PromoDef | null =
    booking.promoDiscountCents <= 0
      ? null
      : credit
        ? { kind: "amount", value: booking.creditAppliedCents }
        : code && code.kind !== "amount"
          ? { kind: code.kind, value: code.value, photographyOnly: code.photographyOnly }
          : { kind: "amount", value: booking.promoDiscountCents };

  let priced: Quote;
  try {
    priced = quote({
      studioIds,
      dayType,
      durationMinutes: booking.durationMinutes,
      rules: catalog.rules,
      bundlePrices: catalog.bundlePrices,
      multiStudioPercent: catalog.settings.multiStudioPercent,
      // At the prices they were booked at: an add-on costs the same any day.
      addons: addonRows.map((row) => ({ addonId: row.addonId, quantity: row.quantity })),
      addonCatalog: addonRows.map((row) => ({ id: row.addonId, name: row.name, priceCents: row.unitCents, studioId: null, maxQuantity: row.quantity, kind: row.kind })),
      promo,
      membership: booking.membershipMinutes > 0 ? { minutesLeft: booking.membershipMinutes, weekendDifference: catalog.settings.memberWeekendDifference } : null,
    });
  } catch (error) {
    if (error instanceof PricingError) return { kind: "refused", message: error.message };
    throw error;
  }
  const creditAppliedCents = credit ? priced.promoDiscountCents : 0;
  const back = booking.creditAppliedCents - creditAppliedCents;
  // The owners may price both kinds of day alike: then nothing changes.
  const unchanged =
    priced.totalCents === booking.totalCents &&
    priced.promoDiscountCents === booking.promoDiscountCents &&
    priced.membershipCents === booking.membershipCents &&
    priced.multiStudioDiscountCents === booking.multiStudioDiscountCents &&
    priced.studioLines.every((line) => holds.find((hold) => hold.studioId === line.studioId)?.priceCents === line.priceCents);
  if (unchanged) return { kind: "same" };
  const codeBack = back > 0 && code ? { codeId: code.id, code: code.code, source: code.source, cents: back } : null;
  return {
    kind: "new",
    dayType,
    wasCents: booking.totalCents,
    quote: priced,
    creditAppliedCents,
    codeBack,
    announced:
      codeBack !== null ||
      priced.totalCents !== booking.totalCents ||
      totalBeforeCredit({ totalCents: priced.totalCents, creditAppliedCents, membershipCents: priced.membershipCents }) !== totalBeforeCredit(booking),
  };
}

/** The history's note of a new price, after "Moved from … to …". Amounts are hidden from staff who may not see prices. */
export function repriceNote(price: Extract<MovePrice, { kind: "new" }>, before: { totalCents: number; creditAppliedCents: number; membershipCents: number }): string {
  const was = totalBeforeCredit(before);
  const now = totalBeforeCredit({ totalCents: price.quote.totalCents, creditAppliedCents: price.creditAppliedCents, membershipCents: price.quote.membershipCents });
  if (!price.announced) return `. Priced as ${PRICED_AS[price.dayType]}: what the client pays is unchanged`;
  // Credit or membership hours paid part of it: what is left after them, when that changed too.
  const paidPart = was !== price.wasCents || now !== price.quote.totalCents;
  return `. Priced as ${PRICED_AS[price.dayType]}: ${formatCents(now)} instead of ${formatCents(was)}${
    paidPart && price.quote.totalCents !== price.wasCents
      ? `; after credit and membership hours, ${formatCents(price.quote.totalCents)} instead of ${formatCents(price.wasCents)}`
      : ""
  }${price.codeBack ? `; ${formatCents(price.codeBack.cents)} went back on the code ${price.codeBack.code}` : ""}`;
}

/**
 * What the client is told of the new price in the email about the move (`price_note` of the template "Booking moved by
 * the studio"): the new total, and then what is still to pay, what comes back to them, or what went back on their code.
 */
export function movePriceText(input: {
  dayType: DayType;
  /** The total before and after, as the confirmation said it: after discounts, before credit and minutes. */
  wasCents: number;
  nowCents: number;
  /** After the move: what is still to pay, and what was paid beyond the new price. */
  owedCents: number;
  creditLeftCents: number;
  codeBack: { code: string; source: PromoSource; cents: number } | null;
}): string {
  return [
    `Its new day is priced as ${PRICED_AS[input.dayType]}, so its total is now ${formatCents(input.nowCents)} instead of ${formatCents(input.wasCents)}.`,
    ...(input.codeBack
      ? [`${formatCents(input.codeBack.cents)} of the ${creditName(input.codeBack.source)} it was paid with is back on that code: ${input.codeBack.code}.`]
      : []),
    ...(input.owedCents > 0 ? [`Still to pay: ${formatCents(input.owedCents)}, at the studio or with a payment link we email you.`] : []),
    ...(input.creditLeftCents > 0 ? [`You have paid ${formatCents(input.creditLeftCents)} more than that: we will refund it to you.`] : []),
  ].join("\n");
}
