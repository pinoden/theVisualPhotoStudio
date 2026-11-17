import { and, eq, sql } from "drizzle-orm";
import { bookingAddons, bookings, promoCodes } from "@/db/schema";
import type { Db, DbLike } from "@/db/client";
import { labelOf } from "@/lib/domain/labels";
import { formatCents } from "@/lib/domain/pricing";
import type { AuthUser } from "./auth";
import { isBookingRef } from "./bookings";
import { petCreditEmail, queueEmail } from "./email";
import { recordEvent } from "./history";
import { netCardPaidCents, paidAtStudioCents } from "./money";
import { issuePromo, rescheduleCodeOf, type RescheduleCode } from "./promos";
import { loadSettings } from "./settings";
import { formatInstant } from "./tz";

/**
 * The pet fee. The owner's rule (2026-11-15): it is not refunded, and when
 * the pet is not brought the fee becomes studio credit.
 *
 * So the fee never goes back to a card. It comes back as a code for its
 * amount, sent to the customer, in two cases: by itself when a booking is
 * cancelled early enough to be refunded (`cancelBooking`), and when an owner
 * records that the pet did not come (`givePetFeeCredit`). One booking gives
 * its pet fee back once: the database allows one such code per booking.
 */

type BookingRow = typeof bookings.$inferSelect;
const DAY = 86_400_000;

/** What the pet add-ons on a booking cost. 0 when it has none. */
export async function petFeeCentsOf(db: DbLike, bookingId: string): Promise<number> {
  const [row] = await db
    .select({ cents: sql<number>`coalesce(sum(${bookingAddons.unitCents} * ${bookingAddons.quantity}), 0)::int` })
    .from(bookingAddons)
    .where(and(eq(bookingAddons.bookingId, bookingId), eq(bookingAddons.kind, "pet")));
  return row.cents;
}

/** The code that returned this booking's pet fee, if it was returned. */
export async function petCreditOf(db: DbLike, bookingId: string): Promise<{ code: string; createdAt: Date } | null> {
  const [row] = await db
    .select({ code: promoCodes.code, createdAt: promoCodes.createdAt })
    .from(promoCodes)
    .where(and(eq(promoCodes.originBookingId, bookingId), eq(promoCodes.source, "pet_fee")))
    .limit(1);
  return row ?? null;
}

/**
 * How much of a booking's pet fee was returned as studio credit: what its
 * code was issued for, which is only part of the fee when only part was paid
 * or part was refunded to the card before; 0 before a code returned it. That
 * money was given back once, so it is neither refunded to the card nor
 * carried by a reschedule code as well.
 */
export async function petFeeReturnedCents(db: DbLike, bookingId: string): Promise<number> {
  const [credit] = await db
    .select({ issued: promoCodes.issuedCents, value: promoCodes.value })
    .from(promoCodes)
    .where(and(eq(promoCodes.originBookingId, bookingId), eq(promoCodes.source, "pet_fee")))
    .limit(1);
  if (!credit) return 0;
  return credit.issued ?? (await petFeeCentsOf(db, bookingId));
}

/**
 * What the studio can still give back by hand of the money it took for a
 * booking: what it holds, less the part of a pet fee returned as studio
 * credit that the card did not hold (`petReturnedCents`, of a fee of
 * `petFeeCents`; the credit itself may be only part of the fee). The pet fee comes back once: as credit, not in cash as well.
 * A booking released for a reschedule code gives back at most what is left on
 * the code (`code`), which the refund then comes off. (The card's side is
 * `ownerRefundable` in manage.ts.)
 */
export async function studioRefundableCents(
  db: DbLike,
  bookingId: string,
): Promise<{ cents: number; petReturnedCents: number; petFeeCents: number; code: RescheduleCode | null }> {
  const atStudio = Math.max(0, await paidAtStudioCents(db, bookingId));
  // The pet fee's credit, which may be only part of the fee: what the card did not hold of it was paid at the studio.
  const credit = await petFeeReturnedCents(db, bookingId);
  const onStudio = credit - Math.min(Math.max(0, await netCardPaidCents(db, bookingId)), credit);
  const cents = Math.max(0, atStudio - onStudio);
  const code = atStudio > 0 ? await rescheduleCodeOf(db, bookingId) : null;
  return {
    cents: code ? Math.min(cents, code.valueCents) : cents,
    petReturnedCents: Math.min(atStudio, onStudio),
    petFeeCents: credit > 0 ? await petFeeCentsOf(db, bookingId) : 0,
    code,
  };
}

/**
 * Turn `cents` of a booking's pet fee into a code for studio credit, in the
 * caller's transaction. Returns null when this booking's fee was already
 * returned. The code is the customer's alone and lasts as long as a
 * reschedule code (`creditValidDays`).
 */
export async function issuePetCredit(
  tx: DbLike,
  booking: Pick<BookingRow, "id" | "ref" | "customerEmail">,
  cents: number,
  deps: { now: Date; validDays: number },
): Promise<{ code: string; expiresAt: Date } | null> {
  if (cents <= 0) return null;
  const expiresAt = new Date(deps.now.getTime() + deps.validDays * DAY);
  const issued = await issuePromo(tx, {
    kind: "amount",
    value: cents,
    source: "pet_fee",
    email: booking.customerEmail,
    expiresAt,
    maxUses: 1_000_000, // limited by the money left on it, not by a count
    originBookingId: booking.id,
    note: `Pet fee of ${booking.ref}, returned as credit`,
    issuedAt: deps.now,
  });
  return issued ? { code: issued.code, expiresAt } : null;
}

export type PetCreditBlock = "no_pet_fee" | "already_given" | "moved" | "not_paid" | "never_confirmed";

export const PET_CREDIT_BLOCK_TEXT: Record<PetCreditBlock, string> = {
  no_pet_fee: "This booking has no pet fee.",
  already_given: "The pet fee of this booking was already returned as studio credit.",
  moved: "This booking was released for a reschedule code, which carries everything that was paid, the pet fee included.",
  not_paid: "Less than the pet fee is left of what was paid for this booking, so there is nothing to return.",
  never_confirmed: "This booking was never confirmed.",
};

/** Whether the pet fee of a booking can be returned as credit now, and how much it is. */
export async function petCreditStanding(
  db: DbLike,
  booking: BookingRow,
): Promise<{ feeCents: number; given: { code: string } | null; block: PetCreditBlock | null }> {
  const feeCents = await petFeeCentsOf(db, booking.id);
  if (feeCents <= 0) return { feeCents: 0, given: null, block: "no_pet_fee" };
  const given = await petCreditOf(db, booking.id);
  if (given) return { feeCents, given: { code: given.code }, block: "already_given" };
  if (booking.status === "pending_payment" || booking.status === "expired") return { feeCents, given: null, block: "never_confirmed" };
  if (booking.cancelReason === "rescheduled") return { feeCents, given: null, block: "moved" };
  const held = (await netCardPaidCents(db, booking.id)) + (await paidAtStudioCents(db, booking.id)) + booking.creditAppliedCents;
  return { feeCents, given: null, block: held < feeCents ? "not_paid" : null };
}

export type PetCreditResult =
  | { ok: true; code: string; cents: number }
  | { ok: false; reason: "forbidden" | "not_found" | PetCreditBlock; message: string };

/**
 * An owner records that the pet did not come: the fee is returned to the
 * customer as studio credit, and they are emailed the code. For a visit that
 * went ahead without the pet, and at the owner's discretion for a booking
 * that was cancelled too late to be refunded.
 */
export async function givePetFeeCredit(
  db: Db,
  viewer: AuthUser,
  ref: string,
  deps: { now: Date; baseUrl: string },
): Promise<PetCreditResult> {
  if (viewer.role !== "owner") return { ok: false, reason: "forbidden", message: "Only an owner can return a pet fee." };
  if (!isBookingRef(ref)) return { ok: false, reason: "not_found", message: "Booking not found." };
  const settings = await loadSettings(db);

  return db.transaction(async (tx): Promise<PetCreditResult> => {
    // Locked, so two presses at once cannot both look and both give.
    const [booking] = await tx.select().from(bookings).where(eq(bookings.ref, ref)).for("update").limit(1);
    if (!booking) return { ok: false, reason: "not_found", message: "Booking not found." };
    const standing = await petCreditStanding(tx, booking);
    if (standing.block) return { ok: false, reason: standing.block, message: PET_CREDIT_BLOCK_TEXT[standing.block] };

    const credit = await issuePetCredit(tx, booking, standing.feeCents, { now: deps.now, validDays: settings.creditValidDays });
    if (!credit) return { ok: false, reason: "already_given", message: PET_CREDIT_BLOCK_TEXT.already_given };

    const label = labelOf(booking);
    await recordEvent(tx, {
      bookingId: booking.id,
      from: label,
      to: label,
      actor: viewer.email,
      at: deps.now,
      note: `The pet did not come: the pet fee of ${formatCents(standing.feeCents)} was returned as studio credit`,
    });
    await queueEmail(
      tx,
      petCreditEmail({
        to: booking.customerEmail,
        name: booking.customerName,
        ref: booking.ref,
        code: credit.code,
        cents: standing.feeCents,
        expires: formatInstant(credit.expiresAt),
        bookUrl: `${deps.baseUrl.replace(/\/$/, "")}/book`,
      }),
    );
    return { ok: true, code: credit.code, cents: standing.feeCents };
  });
}
