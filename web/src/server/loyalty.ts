import { and, eq, sql } from "drizzle-orm";
import { bookings, promoCodes } from "@/db/schema";
import type { DbLike } from "@/db/client";
import { loyaltyStanding, type LoyaltyStanding } from "@/lib/domain/loyalty";
import { freeHourEmail, queueEmail } from "./email";
import { issuePromo } from "./promos";
import type { Settings } from "./settings";
import { formatInstant, localDateOf } from "./tz";

/**
 * The loyalty reward: one free hour for every `loyaltyVisits` visits on
 * separate days. The rule itself is in `src/lib/domain/loyalty.ts`; this file
 * reads a customer's visits and sends what they have earned.
 *
 * A free hour is a single-use code of kind `free_hour`, emailed to the
 * customer. Each one stays valid for `loyaltyValidDays` on its own, and a
 * customer can hold several. Checkout takes one code, so one booking uses one
 * free hour.
 */

/** What one reward is worth: the minutes of one studio that are free. */
export const FREE_HOUR_MINUTES = 60;

const DAY = 86_400_000;

/**
 * Where a customer stands: the days that count, and the free hours earned.
 * Customers are told apart by email address. Only completed visits count, so
 * a cancelled booking or a no-show adds nothing, and photography sessions do
 * not count (the rule is in the domain function).
 */
export async function loyaltyStandingOf(
  db: DbLike,
  email: string,
  settings: Pick<Settings, "loyaltyVisits">,
): Promise<LoyaltyStanding> {
  const rows = await db
    .select({ id: bookings.id, startAt: bookings.startAt, codeKind: promoCodes.kind, photographerId: bookings.photographerId })
    .from(bookings)
    .leftJoin(promoCodes, eq(promoCodes.id, bookings.promoCodeId))
    .where(and(eq(bookings.customerEmail, email.trim().toLowerCase()), eq(bookings.status, "completed")));
  return loyaltyStanding(
    rows.map((row) => ({
      bookingId: row.id,
      day: localDateOf(row.startAt),
      startAt: row.startAt.getTime(),
      usedFreeHour: row.codeKind === "free_hour",
      photography: row.photographerId !== null,
    })),
    settings.loyaltyVisits,
  );
}

/** Free hours ever sent to this address for its visits. Used, expired and cancelled ones count too. */
async function freeHoursSentTo(db: DbLike, email: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(promoCodes)
    .where(and(eq(promoCodes.email, email), eq(promoCodes.source, "loyalty"), eq(promoCodes.kind, "free_hour")));
  return row.n;
}

/**
 * Send a customer the free hours they have earned and not yet been sent, and
 * return how many that was. Runs in the caller's transaction.
 *
 * Safe to repeat, and safe to run twice at once. What is owed is the number
 * earned less the number ever sent, so a visit that stops counting later (a
 * late no-show) cannot lead to a second reward for the same five days. And
 * each free hour belongs to the visit that completed it, of which the
 * database allows one, so two runs cannot both send it.
 */
export async function sendEarnedFreeHours(
  tx: DbLike,
  customer: { email: string; name: string },
  deps: { now: Date; baseUrl: string; settings: Pick<Settings, "loyaltyVisits" | "loyaltyValidDays"> },
): Promise<number> {
  const email = customer.email.trim().toLowerCase();
  const standing = await loyaltyStandingOf(tx, email, deps.settings);
  const alreadySent = await freeHoursSentTo(tx, email);

  let sent = 0;
  for (let index = alreadySent; index < standing.earned; index++) {
    const expiresAt = new Date(deps.now.getTime() + deps.settings.loyaltyValidDays * DAY);
    const promo = await issuePromo(tx, {
      kind: "free_hour",
      value: FREE_HOUR_MINUTES,
      source: "loyalty",
      email,
      expiresAt,
      originBookingId: standing.milestones[index],
      note: `Free hour for ${deps.settings.loyaltyVisits} visits`,
    });
    if (!promo) continue; // another run sent this one
    await queueEmail(
      tx,
      freeHourEmail({
        to: email,
        name: customer.name,
        code: promo.code,
        visits: deps.settings.loyaltyVisits,
        expires: formatInstant(expiresAt),
        bookUrl: `${deps.baseUrl.replace(/\/$/, "")}/book`,
      }),
    );
    sent++;
  }
  return sent;
}
