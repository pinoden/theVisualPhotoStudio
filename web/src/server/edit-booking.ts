import { eq, sql } from "drizzle-orm";
import { bookingAddons, bookings, promoCodes, studioHolds } from "@/db/schema";
import { PG_EXCLUSION_VIOLATION, pgErrorCode, together, type Db, type DbLike } from "@/db/client";
import { extraGuestsFor, studioCombinationError } from "@/lib/catalog-view";
import { isStartFree } from "@/lib/domain/availability";
import { formatCents, PricingError, PROMO_MISFIT_TEXT, quote, unpriced, type PromoDef, type Quote } from "@/lib/domain/pricing";
import { labelOf } from "@/lib/domain/labels";
import { durationLabel } from "@/lib/domain/time";
import type { AuthUser } from "./auth";
import { loadDayAvailability } from "./availability";
import { conflictsAt, loadOverrideDay, overlapping, overrideRefusal, type Conflict } from "./override";
import { isBookingRef } from "./bookings";
import { dayTypeFor, loadCatalog, type Catalog } from "./catalog";
import { bookingChangedEmail, queueEmail } from "./email";
import { recordEvent } from "./history";
import { chargesCentsByBooking, creditLeftCentsByBooking, owedCents } from "./money";
import { addBackToCode, creditName, type PromoSource } from "./promos";
import { propsProblem } from "./props";
import { totalBeforeCredit } from "./reprice";
import { formatInstant, localDateOf, localMinuteOn, localToUtc } from "./tz";

/**
 * A booking's studios, length, guests and add-ons changed by an owner (the owner's admin brief of 2026-11-22, item 5,
 * "Edit"; the owner's answer of 2026-11-23: "Editing price is for owner only"; question 75 in ProjectLibrary.md).
 *
 * The booking keeps its day and start, and is priced again as a move to a day of the other kind is (reprice.ts): today's
 * price list for its studios and length, the add-ons it kept at the prices they were booked at and new ones at today's,
 * a percent code taking its percentage again, credit paying what it paid up to the new price and what the new price no
 * longer needs going back on its code. What it owes then, or was paid beyond its new price, is settled as after a move:
 * a payment at the studio or a payment link, or a refund (the appointment's page). The time must be free in every studio
 * it holds now, inside their hours, with the gap after it, and its props free, unless the owner passes over what is in
 * the way, having read it in a pop-up (question 79; src/server/override.ts).
 */
export interface EditInput {
  studioIds: string[];
  durationMinutes: number;
  addons: { addonId: string; quantity: number }[];
  /** The owner's override (question 79): the keys of what the change passes over, read in the pop-up. Null: none. */
  override?: string[] | null;
}

export type EditResult =
  | {
      ok: true;
      /** The total before and after, as the client reads it: after discounts, before credit. */
      wasCents: number;
      nowCents: number;
      /** After the change: what the booking still owes, and what it was paid beyond its new price. */
      owedCents: number;
      creditLeftCents: number;
      codeBack: { code: string; cents: number } | null;
    }
  | { ok: false; message: string };

type BookingRow = typeof bookings.$inferSelect;

const refuse = (message: string): EditResult => ({ ok: false, message });

/** "Studio Paris + Studio Dayglow, 2 hours, Extra guest × 2": what a booking holds, in the history and the email. */
function whatText(catalog: Catalog, studioIds: string[], minutes: number, addons: { name: string; quantity: number }[]): string {
  const names = catalog.studios.filter((studio) => studioIds.includes(studio.id)).map((studio) => studio.name);
  const extras = addons.map((addon) => (addon.quantity > 1 ? `${addon.name} × ${addon.quantity}` : addon.name));
  return [names.join(" + ") || "A studio taken off the site", durationLabel(minutes), ...extras].join(", ");
}

export async function editBooking(db: Db, viewer: AuthUser, ref: string, input: EditInput, now: Date): Promise<EditResult> {
  if (viewer.role !== "owner") return refuse("Only an owner can change a booking's studios, length, guests or add-ons: it changes its price.");
  if (!isBookingRef(ref)) return refuse("Booking not found.");
  const [found] = await db.select().from(bookings).where(eq(bookings.ref, ref)).limit(1);
  if (!found) return refuse("Booking not found.");
  const problem = await whyNotEditable(db, found, now);
  if (problem) return refuse(problem);

  const catalog = await loadCatalog(db);
  const studioIds = [...new Set(input.studioIds)];
  if (studioIds.length === 0) return refuse("Choose at least one studio.");
  if (!studioIds.every((id) => catalog.studios.some((studio) => studio.id === id))) return refuse("Choose studios on the site.");
  const combination = studioCombinationError(catalog.studios, studioIds);
  if (combination) return refuse(combination);
  const minutes = input.durationMinutes;
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes % catalog.settings.slotIncrementMinutes !== 0) return refuse("Choose a length.");

  const date = localDateOf(found.startAt);
  const startMinute = localMinuteOn(found.startAt, date);
  const endAt = localToUtc(date, startMinute + minutes);
  if (endAt.getTime() - found.startAt.getTime() !== minutes * 60_000) return refuse("That length would cross the hour the clocks change. Choose another, or move the booking first.");
  // The kind of day it is priced as, as a move compares it (reprice.ts).
  const dayType = found.pricedAs ?? dayTypeFor(catalog, date);
  const gap = unpriced(studioIds, dayType, minutes, catalog.rules, catalog.bundlePrices);
  if (gap) {
    const names = gap.studioIds.map((id) => catalog.studios.find((studio) => studio.id === id)!.name).join(" and ");
    return refuse(
      gap.together
        ? `${names} have no price together for ${durationLabel(minutes)} under Prices.`
        : `${names} ${gap.studioIds.length > 1 ? "have" : "has"} no ${dayType} price for ${durationLabel(minutes)} under Prices.`,
    );
  }

  // Free at its start in every studio, for the new length, its own time left out.
  // With the owner's override (question 79), what it passes over, each thing read in the pop-up.
  let passedOver: Conflict[] = [];
  if (input.override) {
    passedOver = conflictsAt(await loadOverrideDay(db, catalog, { date, studioIds, excludeBookingId: found.id }), startMinute, minutes);
    const refusal = overrideRefusal(passedOver, input.override);
    if (refusal) return refuse(refusal);
  } else {
    const day = await loadDayAvailability(db, catalog, date, now, { asAdmin: true, excludeBookingId: found.id });
    const slot = { durationMinutes: minutes, incrementMinutes: 1, earliestStartMinute: 0 };
    const taken = studioIds.filter((id) => {
      const studioDay = day.days.find((studio) => studio.studioId === id);
      return !studioDay || !isStartFree(studioDay, startMinute, slot);
    });
    if (taken.length > 0) {
      const names = taken.map((id) => catalog.studios.find((studio) => studio.id === id)!.name).join(" and ");
      return refuse(
        `${names} ${taken.length > 1 ? "are" : "is"} not free for ${durationLabel(minutes)} from ${formatInstant(found.startAt)}, with the gap after it, inside the opening hours. Choose another studio or length, or move the booking first.`,
      );
    }
  }
  const overlaps = overlapping(passedOver);

  const [held, kept, code] = await together(db, [
    () => db.select({ studioId: studioHolds.studioId }).from(studioHolds).where(eq(studioHolds.bookingId, found.id)),
    () => db.select().from(bookingAddons).where(eq(bookingAddons.bookingId, found.id)),
    () => (found.promoCodeId ? db.select().from(promoCodes).where(eq(promoCodes.id, found.promoCodeId)).limit(1) : Promise.resolve([])),
  ]);
  const wanted = input.addons.filter((addon) => addon.quantity > 0);
  const sameStudios = [...held.map((hold) => hold.studioId)].sort().join(",") === [...studioIds].sort().join(",");
  const sameAddons =
    wanted.length === kept.length && wanted.every((addon) => kept.some((row) => row.addonId === addon.addonId && row.quantity === addon.quantity));
  if (sameStudios && minutes === found.durationMinutes && sameAddons) return refuse("Nothing was changed.");

  // An add-on it keeps costs what it was booked at; a new one, today's price.
  const addonCatalog = wanted.map((addon) => {
    const before = kept.find((row) => row.addonId === addon.addonId);
    const offered = catalog.addons.find((entry) => entry.id === addon.addonId);
    if (before) {
      return { id: before.addonId, name: before.name, priceCents: before.unitCents, studioId: offered?.studioId ?? null, maxQuantity: Math.max(before.quantity, offered?.maxQuantity ?? 0), kind: before.kind };
    }
    return offered ?? null;
  });
  if (addonCatalog.some((entry) => entry === null)) return refuse("An add-on chosen is no longer offered.");

  const credit = found.creditAppliedCents > 0;
  const [usedCode] = code;
  if (credit && !usedCode) return refuse("The code this booking was paid with no longer exists, so its price cannot be worked out again.");
  const promo: PromoDef | null =
    found.promoDiscountCents <= 0
      ? null
      : credit
        ? { kind: "amount", value: found.creditAppliedCents }
        : usedCode && usedCode.kind !== "amount"
          ? { kind: usedCode.kind, value: usedCode.value, photographyOnly: usedCode.photographyOnly }
          : { kind: "amount", value: found.promoDiscountCents };
  let priced: Quote;
  try {
    priced = quote({
      studioIds,
      dayType,
      durationMinutes: minutes,
      rules: catalog.rules,
      bundlePrices: catalog.bundlePrices,
      multiStudioPercent: catalog.settings.multiStudioPercent,
      addons: wanted,
      addonCatalog: addonCatalog as NonNullable<(typeof addonCatalog)[number]>[],
      extraGuestsAllowed: extraGuestsFor(catalog, studioIds),
      promo,
    });
  } catch (error) {
    if (error instanceof PricingError) return refuse(error.message);
    throw error;
  }
  if (priced.promoMisfit) return refuse(`${PROMO_MISFIT_TEXT[priced.promoMisfit]} It paid for this booking, so the booking cannot be changed so.`);
  const creditAppliedCents = credit ? priced.promoDiscountCents : 0;
  const back = found.creditAppliedCents - creditAppliedCents;
  const codeBack = back > 0 && usedCode ? { codeId: usedCode.id, code: usedCode.code, source: usedCode.source, cents: back } : null;

  const before = whatText(
    catalog,
    held.map((hold) => hold.studioId),
    found.durationMinutes,
    kept,
  );
  const after = whatText(catalog, studioIds, minutes, priced.addonLines);
  const wasCents = totalBeforeCredit(found);
  const nowCents = totalBeforeCredit({ totalCents: priced.totalCents, creditAppliedCents, membershipCents: 0 });

  try {
    await db.transaction(async (tx) => {
      const [booking] = await tx.select().from(bookings).where(eq(bookings.id, found.id)).for("update").limit(1);
      const again = booking ? await whyNotEditable(tx, booking, now) : "Booking not found.";
      if (again) throw new EditRefused(again);
      const propProblem = await propsProblem(tx, wanted, booking.startAt, endAt, booking.id);
      if (propProblem) throw new EditRefused(propProblem);

      await tx
        .update(bookings)
        .set({
          durationMinutes: minutes,
          endAt,
          studiosSubtotalCents: priced.studiosSubtotalCents,
          multiStudioDiscountCents: priced.multiStudioDiscountCents,
          addonsCents: priced.addonsCents,
          promoDiscountCents: priced.promoDiscountCents,
          creditAppliedCents,
          totalCents: priced.totalCents,
        })
        .where(eq(bookings.id, booking.id));
      // Its studios, each with its own gap after the booking and its price now. The database refuses two bookings of
      // one studio at the same time, so a time taken meanwhile ends the change here.
      await tx.delete(studioHolds).where(eq(studioHolds.bookingId, booking.id));
      for (const line of priced.studioLines) {
        const buffer = catalog.studios.find((studio) => studio.id === line.studioId)?.bufferMinutes ?? 0;
        const occupiedEnd = new Date(endAt.getTime() + buffer * 60_000);
        await tx.insert(studioHolds).values({
          studioId: line.studioId,
          bookingId: booking.id,
          priceCents: line.priceCents,
          occupied: sql`tstzrange(${booking.startAt.toISOString()}::timestamptz, ${occupiedEnd.toISOString()}::timestamptz, '[)')`,
          overlapAllowed: overlaps.has(line.studioId),
        });
      }
      await tx.delete(bookingAddons).where(eq(bookingAddons.bookingId, booking.id));
      if (priced.addonLines.length > 0) {
        await tx.insert(bookingAddons).values(
          priced.addonLines.map((line) => ({
            bookingId: booking.id,
            addonId: line.addonId,
            name: line.name,
            quantity: line.quantity,
            unitCents: line.unitCents,
            kind: kept.find((row) => row.addonId === line.addonId)?.kind ?? catalog.addons.find((addon) => addon.id === line.addonId)?.kind ?? "other",
          })),
        );
      }
      if (codeBack) await addBackToCode(tx, codeBack.codeId, codeBack.cents);

      const label = labelOf(booking);
      await recordEvent(tx, {
        bookingId: booking.id,
        from: label,
        to: label,
        actor: viewer.email,
        at: now,
        note: `Changed from ${before} to ${after}${nowCents === wasCents ? "; the price is the same" : `: ${formatCents(nowCents)} instead of ${formatCents(wasCents)}`}${
          codeBack ? `; ${formatCents(codeBack.cents)} went back on the code ${codeBack.code}` : ""
        }${passedOver.length > 0 ? `; over: ${passedOver.map((conflict) => conflict.text).join("; ")}` : ""}`,
      });
      const money = await moneyAfter(tx, booking, priced.totalCents, now);
      await queueEmail(
        tx,
        bookingChangedEmail({
          to: booking.customerEmail,
          name: booking.customerName,
          ref: booking.ref,
          studios: catalog.studios.filter((studio) => studioIds.includes(studio.id)).map((studio) => studio.name).join(" + "),
          when: formatInstant(booking.startAt),
          duration: durationLabel(minutes),
          addons: priced.addonLines.map((line) => (line.quantity > 1 ? `${line.name} × ${line.quantity}` : line.name)).join(", ") || "None",
          before,
          priceNote: changePriceText({ wasCents, nowCents, ...money, codeBack }),
        }),
      );
    });
  } catch (error) {
    if (error instanceof EditRefused) return refuse(error.message);
    if (pgErrorCode(error) === PG_EXCLUSION_VIOLATION) return refuse("That time was just taken in one of the studios. Look again.");
    throw error;
  }
  const money = await moneyAfter(db, found, priced.totalCents, now);
  return { ok: true, wasCents, nowCents, ...money, codeBack: codeBack ? { code: codeBack.code, cents: codeBack.cents } : null };
}

class EditRefused extends Error {}

/** Why this booking cannot be changed here, or null when it can. */
async function whyNotEditable(db: DbLike, booking: BookingRow, now: Date): Promise<string | null> {
  if (booking.status !== "confirmed") return "Only a confirmed booking can be changed.";
  if (now.getTime() >= booking.startAt.getTime()) return "Only a booking that has not started can be changed. Time added during a visit is an extra charge.";
  if (booking.endRequest) return "The client has asked to cancel or release this booking, and that waits for the card processor: it cannot be changed meanwhile.";
  if (booking.photographerId !== null) return "A session's studio and length are those of the session sold: move it, or cancel it and book another.";
  if (booking.membershipMinutes > 0) return "This booking was paid with membership hours: cancel it and book again, so that the hours go back first.";
  if ((await chargesCentsByBooking(db, [booking.id])).has(booking.id)) return "This booking has extra charges, so it cannot be changed.";
  return null;
}

/** What the booking's money is after the change: what it owes, and what it was paid beyond its new price. */
async function moneyAfter(db: DbLike, booking: { id: string; status: string }, totalCents: number, now: Date): Promise<{ owedCents: number; creditLeftCents: number }> {
  const after = { id: booking.id, status: booking.status, totalCents };
  return { owedCents: await owedCents(db, after, now), creditLeftCents: (await creditLeftCentsByBooking(db, [after])).get(booking.id) ?? 0 };
}

/** The email's note of the new price: the new total, and what follows from it. */
function changePriceText(input: { wasCents: number; nowCents: number; owedCents: number; creditLeftCents: number; codeBack: { code: string; source: PromoSource; cents: number } | null }): string {
  if (input.wasCents === input.nowCents && !input.codeBack) return "Its price is the same.";
  return [
    `Its total is now ${formatCents(input.nowCents)} instead of ${formatCents(input.wasCents)}.`,
    ...(input.codeBack ? [`${formatCents(input.codeBack.cents)} of the ${creditName(input.codeBack.source)} it was paid with is back on that code: ${input.codeBack.code}.`] : []),
    ...(input.owedCents > 0 ? [`Still to pay: ${formatCents(input.owedCents)}, at the studio or with a payment link we email you.`] : []),
    ...(input.creditLeftCents > 0 ? [`You have paid ${formatCents(input.creditLeftCents)} more than that: we will refund it to you.`] : []),
  ].join("\n");
}

/** What the owner's form for changing a booking offers (question 75), or why it cannot be changed. */
export type EditOptions =
  | {
      editable: true;
      studios: { id: string; name: string; chosen: boolean }[];
      /** The lengths the price list has for the kind of day the booking is priced as, the booking's own among them. */
      lengths: number[];
      durationMinutes: number;
      addons: { id: string; name: string; priceCents: number; quantity: number; most: number; studioName: string | null }[];
    }
  | { editable: false; why: string };

export async function editOptions(db: DbLike, viewer: AuthUser, ref: string, now: Date): Promise<EditOptions | null> {
  if (viewer.role !== "owner" || !isBookingRef(ref)) return null;
  const [booking] = await db.select().from(bookings).where(eq(bookings.ref, ref)).limit(1);
  if (!booking) return null;
  const why = await whyNotEditable(db, booking, now);
  if (why) return { editable: false, why };
  const catalog = await loadCatalog(db);
  const [held, kept] = await together(db, [
    () => db.select({ studioId: studioHolds.studioId }).from(studioHolds).where(eq(studioHolds.bookingId, booking.id)),
    () => db.select().from(bookingAddons).where(eq(bookingAddons.bookingId, booking.id)),
  ]);
  const dayType = booking.pricedAs ?? dayTypeFor(catalog, localDateOf(booking.startAt));
  const lengths = [...new Set([...catalog.rules.filter((rule) => rule.dayType === dayType).map((rule) => rule.durationMinutes), ...catalog.bundlePrices.map((price) => price.durationMinutes), booking.durationMinutes])].sort((a, b) => a - b);
  const offered = catalog.addons.map((addon) => ({
    id: addon.id,
    name: addon.name,
    priceCents: kept.find((row) => row.addonId === addon.id)?.unitCents ?? addon.priceCents,
    quantity: kept.find((row) => row.addonId === addon.id)?.quantity ?? 0,
    most: Math.max(addon.maxQuantity, kept.find((row) => row.addonId === addon.id)?.quantity ?? 0),
    studioName: addon.studioId ? (catalog.studios.find((studio) => studio.id === addon.studioId)?.name ?? null) : null,
  }));
  // An add-on it has that the site no longer offers stays listed, so the form does not take it away unasked.
  const gone = kept
    .filter((row) => !catalog.addons.some((addon) => addon.id === row.addonId))
    .map((row) => ({ id: row.addonId, name: row.name, priceCents: row.unitCents, quantity: row.quantity, most: row.quantity, studioName: null }));
  return {
    editable: true,
    studios: catalog.studios.map((studio) => ({ id: studio.id, name: studio.name, chosen: held.some((hold) => hold.studioId === studio.id) })),
    lengths,
    durationMinutes: booking.durationMinutes,
    addons: [...offered, ...gone],
  };
}
