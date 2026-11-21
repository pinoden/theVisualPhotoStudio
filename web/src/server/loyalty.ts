import { and, desc, eq, gte, inArray, isNull, notLike, or, sql } from "drizzle-orm";
import { bookings, loyaltyLedger, promoCodes } from "@/db/schema";
import type { DbLike } from "@/db/client";
import { ACUITY_HISTORY_SOURCE } from "@/lib/acuity";
import { loyaltyStanding, type LoyaltyStanding } from "@/lib/domain/loyalty";
import { freeHourEmail, queueEmail } from "./email";
import { issuePromo } from "./promos";
import { loyaltyStart, type Settings } from "./settings";
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
 *
 * Loyalty switched off and on again starts over (the owner's answer of
 * 2026-11-17): stamps are counted from `loyaltyStartedAt`, so visits and
 * changes by hand from before it are left out. Free hours sent before it
 * stay valid, and keep their numbers.
 */

/** What one reward is worth: the minutes of one studio that are free. */
export const FREE_HOUR_MINUTES = 60;

const DAY = 86_400_000;

/** The stamps an administrator added or took away for a customer, in total: since `since`, when loyalty started over. */
async function stampAdjustmentOf(db: DbLike, email: string, since: Date | null = null): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${loyaltyLedger.stamps}), 0)::int` })
    .from(loyaltyLedger)
    .where(
      and(
        eq(loyaltyLedger.email, email.trim().toLowerCase()),
        eq(loyaltyLedger.kind, "stamps"),
        since ? gte(loyaltyLedger.createdAt, since) : undefined,
      ),
    );
  return row.total;
}

/**
 * Where a customer stands: the days that count, the stamps an administrator
 * changed by hand, and the free hours earned. Customers are told apart by
 * email address. Only completed visits count, so a cancelled booking or a
 * no-show adds nothing, and photography sessions do not count (the rule is in
 * the domain function). After loyalty was switched off and on again, only
 * visits that began since then count, and only the changes made since. A past
 * visit brought in from Acuity's history counts for nothing until the owners
 * say otherwise (question 51 in ProjectLibrary.md): it is shown, not counted.
 */
export async function loyaltyStandingOf(
  db: DbLike,
  email: string,
  settings: Pick<Settings, "loyaltyVisits" | "loyaltyStartedAt">,
): Promise<LoyaltyStanding> {
  const address = email.trim().toLowerCase();
  const since = loyaltyStart(settings);
  const rows = await db
    .select({ id: bookings.id, startAt: bookings.startAt, codeKind: promoCodes.kind, photographerId: bookings.photographerId })
    .from(bookings)
    .leftJoin(promoCodes, eq(promoCodes.id, bookings.promoCodeId))
    .where(
      and(
        eq(bookings.customerEmail, address),
        eq(bookings.status, "completed"),
        since ? gte(bookings.startAt, since) : undefined,
        or(isNull(bookings.importedFrom), notLike(bookings.importedFrom, `${ACUITY_HISTORY_SOURCE}:%`)),
      ),
    );
  return loyaltyStanding(
    rows.map((row) => ({
      bookingId: row.id,
      day: localDateOf(row.startAt),
      startAt: row.startAt.getTime(),
      usedFreeHour: row.codeKind === "free_hour",
      photography: row.photographerId !== null,
    })),
    settings.loyaltyVisits,
    await stampAdjustmentOf(db, address, since),
  );
}

export interface StampChange {
  at: string;
  /** Stamps added (positive) or taken away (negative). */
  stamps: number;
  reason: string;
  /** The administrator who made the change. */
  actor: string;
}

/**
 * The changes an administrator made to a customer's stamps by hand, newest
 * first. With `since`, only those made from then on: the ones that count
 * after loyalty started over.
 */
export async function listStampChanges(db: DbLike, email: string, since: Date | null = null): Promise<StampChange[]> {
  const rows = await db
    .select()
    .from(loyaltyLedger)
    .where(
      and(
        eq(loyaltyLedger.email, email.trim().toLowerCase()),
        eq(loyaltyLedger.kind, "stamps"),
        since ? gte(loyaltyLedger.createdAt, since) : undefined,
      ),
    )
    .orderBy(desc(loyaltyLedger.createdAt));
  return rows.map((row) => ({ at: row.createdAt.toISOString(), stamps: row.stamps, reason: row.reason, actor: row.actor }));
}

/**
 * Free hours ever sent to this address for its visits: how many before
 * loyalty started over, and how many since. Used, expired and cancelled ones
 * count too. While loyalty has never started over, all of them are "since".
 */
async function freeHoursSentTo(db: DbLike, email: string, since: Date | null): Promise<{ before: number; since: number }> {
  const [row] = await db
    .select({
      all: sql<number>`count(*)::int`,
      since: since ? sql<number>`(count(*) filter (where ${promoCodes.createdAt} >= ${since.toISOString()}::timestamptz))::int` : sql<number>`count(*)::int`,
    })
    .from(promoCodes)
    .where(and(eq(promoCodes.email, email), eq(promoCodes.source, "loyalty"), eq(promoCodes.kind, "free_hour")));
  return { before: row.all - row.since, since: row.since };
}

/**
 * Send a customer the free hours they have earned and not yet been sent, and
 * return how many that was. Runs in the caller's transaction.
 *
 * Safe to repeat, and safe to run twice at once. What is owed is the number
 * earned less the number sent, both counted since loyalty last started, so a
 * visit that stops counting later (a late no-show) cannot lead to a second
 * reward for the same five days. And each free hour is numbered (a customer's
 * first, second, third, over every start of loyalty), and the database allows
 * each number once per customer, so two runs cannot both send it.
 */
export async function sendEarnedFreeHours(
  tx: DbLike,
  customer: { email: string; name: string },
  deps: { now: Date; baseUrl: string; settings: Pick<Settings, "loyaltyVisits" | "loyaltyValidDays" | "loyaltyStartedAt"> },
): Promise<number> {
  const email = customer.email.trim().toLowerCase();
  const standing = await loyaltyStandingOf(tx, email, deps.settings);
  const alreadySent = await freeHoursSentTo(tx, email, loyaltyStart(deps.settings));
  // A free hour that visits of test mode helped to earn (a server in test mode beside the live one) is test mode's: a
  // code is of its booking's kind of money (`moneyKindOfCode`), so such a visit stands for it, a real booking refuses
  // it, and clearing test mode removes it. Which visits a free hour counted: the days the milestones are taken from.
  const visits = deps.settings.loyaltyVisits;
  const kinds = new Map(
    standing.days.length > 0
      ? (
          await tx
            .select({ id: bookings.id, kind: bookings.moneyKind })
            .from(bookings)
            .where(inArray(bookings.id, standing.days.map((day) => day.bookingId)))
        ).map((row) => [row.id, row.kind])
      : [],
  );
  const testVisitOf = (index: number) =>
    standing.days
      .slice(Math.max(0, index * visits - standing.adjustment), Math.max(0, (index + 1) * visits - standing.adjustment))
      .find((day) => kinds.get(day.bookingId) === "test");
  // The visit that completed it, as always; a visit of test mode in its place only when the one that completed it is real.
  const originOf = (index: number) => {
    const milestone = standing.milestones[index];
    return milestone && kinds.get(milestone) === "live" ? (testVisitOf(index)?.bookingId ?? milestone) : milestone;
  };

  let sent = 0;
  for (let index = alreadySent.since; index < standing.earned; index++) {
    const expiresAt = new Date(deps.now.getTime() + deps.settings.loyaltyValidDays * DAY);
    const promo = await issuePromo(tx, {
      kind: "free_hour",
      value: FREE_HOUR_MINUTES,
      source: "loyalty",
      email,
      expiresAt,
      originBookingId: originOf(index),
      loyaltySeq: alreadySent.before + index + 1,
      note: `Free hour for ${deps.settings.loyaltyVisits} visits`,
      issuedAt: deps.now,
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
