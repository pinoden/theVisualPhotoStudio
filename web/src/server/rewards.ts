import { and, desc, eq, inArray } from "drizzle-orm";
import { bookings, loyaltyLedger, promoCodes } from "@/db/schema";
import type { Db, DbLike } from "@/db/client";
import type { LoyaltyStanding } from "@/lib/domain/loyalty";
import { normalizeEmail, type AuthUser } from "./auth";
import { loyaltyStandingOf, sendEarnedFreeHours } from "./loyalty";
import type { PromoSource } from "./promos";
import { loadSettings } from "./settings";

/**
 * Rewards, as a customer sees them in their account and as an owner corrects
 * them. A reward is a free hour: a single-use code of kind `free_hour`,
 * earned by visits or handed out by the studio.
 *
 * Its status is worked out, never stored, so it cannot disagree with the
 * facts: Canceled when an owner cancelled the code, Redeemed when a booking
 * that still stands used it, Expired when its date has passed, Available
 * otherwise. A reward used on a booking that was then cancelled is Available
 * again, because the cancellation gave the code back.
 *
 * What an owner changes by hand (stamps added or taken away, a reward
 * cancelled or given back) is written to `loyalty_ledger` with who, when and
 * why. Only owners can: every function here checks the viewer.
 */

export type RewardStatus = "available" | "redeemed" | "expired" | "cancelled";

/** The names of the statuses, in the owner's words. */
export const REWARD_STATUS_TEXT: Record<RewardStatus, string> = {
  available: "Available",
  redeemed: "Redeemed",
  expired: "Expired",
  cancelled: "Canceled",
};

export const REWARD_NAME = "Free Studio Hour";

export interface Reward {
  id: string;
  name: string;
  code: string;
  issuedAt: string;
  expiresAt: string | null;
  status: RewardStatus;
  /** For a redeemed reward: when it was used, and the appointment it was used for. */
  redeemed: { at: string; bookingRef: string; visitAt: string } | null;
  /** Earned by visits, or handed out by the studio. */
  source: PromoSource;
  /** What the studio wrote beside a reward it handed out. */
  note: string;
}

type CodeRow = typeof promoCodes.$inferSelect;

function statusOf(code: Pick<CodeRow, "voidedAt" | "expiresAt">, redeemed: boolean, now: Date): RewardStatus {
  if (code.voidedAt) return "cancelled";
  if (redeemed) return "redeemed";
  if (code.expiresAt && code.expiresAt.getTime() <= now.getTime()) return "expired";
  return "available";
}

/**
 * Every reward ever given to an email address, newest first, each with its
 * status. Nothing is left out: used, expired and cancelled rewards stay in
 * the history.
 */
export async function listRewards(db: DbLike, email: string, now: Date): Promise<Reward[]> {
  const address = email.trim().toLowerCase();
  const codes = await db
    .select()
    .from(promoCodes)
    .where(and(eq(promoCodes.email, address), eq(promoCodes.kind, "free_hour")))
    .orderBy(desc(promoCodes.createdAt));
  if (codes.length === 0) return [];

  // The bookings that used them and still stand. A cancelled booking gave its code back.
  const used = await db
    .select({ codeId: bookings.promoCodeId, ref: bookings.ref, madeAt: bookings.createdAt, startAt: bookings.startAt })
    .from(bookings)
    .where(
      and(
        inArray(
          bookings.promoCodeId,
          codes.map((code) => code.id),
        ),
        inArray(bookings.status, ["confirmed", "completed", "no_show"]),
      ),
    )
    .orderBy(desc(bookings.createdAt));

  return codes.map((code) => {
    const booking = used.find((row) => row.codeId === code.id);
    const redeemed = booking !== undefined || code.usedCount >= code.maxUses;
    return {
      id: code.id,
      name: REWARD_NAME,
      code: code.code,
      issuedAt: code.createdAt.toISOString(),
      expiresAt: code.expiresAt ? code.expiresAt.toISOString() : null,
      status: statusOf(code, redeemed, now),
      redeemed: booking ? { at: booking.madeAt.toISOString(), bookingRef: booking.ref, visitAt: booking.startAt.toISOString() } : null,
      source: code.source,
      note: code.note,
    };
  });
}

export interface RewardChange {
  at: string;
  kind: "reward_cancelled" | "reward_restored";
  code: string | null;
  reason: string;
  actor: string;
}

/** What owners did to a customer's rewards by hand, newest first. */
export async function listRewardChanges(db: DbLike, email: string): Promise<RewardChange[]> {
  const rows = await db
    .select({ entry: loyaltyLedger, code: promoCodes.code })
    .from(loyaltyLedger)
    .leftJoin(promoCodes, eq(promoCodes.id, loyaltyLedger.codeId))
    .where(and(eq(loyaltyLedger.email, email.trim().toLowerCase()), inArray(loyaltyLedger.kind, ["reward_cancelled", "reward_restored"])))
    .orderBy(desc(loyaltyLedger.createdAt));
  return rows.map(({ entry, code }) => ({
    at: entry.createdAt.toISOString(),
    kind: entry.kind as RewardChange["kind"],
    code,
    reason: entry.reason,
    actor: entry.actor,
  }));
}

// ── What an owner corrects by hand ───────────────────────────────────────────

export const MAX_STAMPS_AT_ONCE = 50;
export const REASON_MIN = 3;
export const REASON_MAX = 300;

function cleanReason(reason: string): string | null {
  const text = reason.replace(/\s+/g, " ").trim();
  return text.length >= REASON_MIN && text.length <= REASON_MAX ? text : null;
}

const NO_REASON = `Say why, in ${REASON_MIN} to ${REASON_MAX} characters: the change is recorded with your reason.`;

export type AdjustStampsResult =
  | { ok: true; standing: LoyaltyStanding; /** Free hours this change earned, sent to the customer at once. */ sent: number }
  | { ok: false; message: string };

/**
 * Add stamps to a customer, or take some away, with a reason: a visit from
 * before the site counted them, a stamp given by mistake. The change is one
 * row of the ledger; the visits themselves are not touched. Stamps that
 * complete a free hour send it at once, as a visit would.
 */
export async function adjustStamps(
  db: Db,
  viewer: AuthUser,
  input: { email: string; stamps: number; reason: string },
  deps: { now: Date; baseUrl: string },
): Promise<AdjustStampsResult> {
  if (viewer.role !== "owner") return { ok: false, message: "Only an owner can change stamps." };
  const email = normalizeEmail(input.email);
  if (!email) return { ok: false, message: "That is not a valid email address." };
  if (!Number.isInteger(input.stamps) || input.stamps === 0 || Math.abs(input.stamps) > MAX_STAMPS_AT_ONCE) {
    return { ok: false, message: `Enter how many stamps to add or take away: a whole number from 1 to ${MAX_STAMPS_AT_ONCE}.` };
  }
  const reason = cleanReason(input.reason);
  if (!reason) return { ok: false, message: NO_REASON };
  const settings = await loadSettings(db);

  return db.transaction(async (tx): Promise<AdjustStampsResult> => {
    const before = await loyaltyStandingOf(tx, email, settings);
    // Stamps cannot go below nothing: taking away more than there are would leave a hidden debt
    // that silently swallowed the customer's next visits.
    if (before.stamps + input.stamps < 0) {
      return { ok: false, message: `This customer has ${before.stamps === 1 ? "1 stamp" : `${before.stamps} stamps`}: no more than that can be taken away.` };
    }
    await tx.insert(loyaltyLedger).values({ email, kind: "stamps", stamps: input.stamps, reason, actor: viewer.email, createdAt: deps.now });

    // A free hour these stamps completed goes out now. While loyalty is switched off nothing is sent,
    // as for visits: it follows at the customer's next visit once it is on.
    let sent = 0;
    if (settings.loyaltyEnabled && input.stamps > 0) {
      const [latest] = await tx
        .select({ name: bookings.customerName })
        .from(bookings)
        .where(eq(bookings.customerEmail, email))
        .orderBy(desc(bookings.createdAt))
        .limit(1);
      sent = await sendEarnedFreeHours(tx, { email, name: latest?.name ?? "there" }, { now: deps.now, baseUrl: deps.baseUrl, settings });
    }
    return { ok: true, standing: await loyaltyStandingOf(tx, email, settings), sent };
  });
}

export type RewardChangeResult = { ok: true; code: string } | { ok: false; message: string };

/** The reward an owner wants to change: a free hour that belongs to one customer. */
async function rewardForUpdate(tx: DbLike, codeId: string): Promise<CodeRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(codeId)) return null;
  const [code] = await tx
    .select()
    .from(promoCodes)
    .where(and(eq(promoCodes.id, codeId), eq(promoCodes.kind, "free_hour")))
    .for("update")
    .limit(1);
  return code?.email ? code : null;
}

/**
 * Cancel a reward: it can no longer be used, and the customer sees it as
 * Canceled. For a reward that should not have been given. A reward that was
 * already used is not cancelled: the booking it paid for stands.
 */
export async function cancelReward(db: Db, viewer: AuthUser, codeId: string, reason: string, now: Date): Promise<RewardChangeResult> {
  if (viewer.role !== "owner") return { ok: false, message: "Only an owner can cancel a reward." };
  const why = cleanReason(reason);
  if (!why) return { ok: false, message: NO_REASON };
  return db.transaction(async (tx): Promise<RewardChangeResult> => {
    const code = await rewardForUpdate(tx, codeId);
    if (!code) return { ok: false, message: "That reward was not found." };
    if (code.voidedAt) return { ok: false, message: "That reward is already cancelled." };
    if (code.usedCount >= code.maxUses) return { ok: false, message: "That reward was already used, so there is nothing left to cancel." };
    await tx.update(promoCodes).set({ voidedAt: now }).where(eq(promoCodes.id, code.id));
    await tx.insert(loyaltyLedger).values({ email: code.email!, kind: "reward_cancelled", codeId: code.id, reason: why, actor: viewer.email, createdAt: now });
    return { ok: true, code: code.code };
  });
}

/**
 * Give a cancelled reward back: it can be used again, until the date it
 * always had. For a reward cancelled by mistake.
 */
export async function restoreReward(db: Db, viewer: AuthUser, codeId: string, reason: string, now: Date): Promise<RewardChangeResult> {
  if (viewer.role !== "owner") return { ok: false, message: "Only an owner can give a reward back." };
  const why = cleanReason(reason);
  if (!why) return { ok: false, message: NO_REASON };
  return db.transaction(async (tx): Promise<RewardChangeResult> => {
    const code = await rewardForUpdate(tx, codeId);
    if (!code) return { ok: false, message: "That reward was not found." };
    if (!code.voidedAt) return { ok: false, message: "That reward is not cancelled." };
    await tx.update(promoCodes).set({ voidedAt: null }).where(eq(promoCodes.id, code.id));
    await tx.insert(loyaltyLedger).values({ email: code.email!, kind: "reward_restored", codeId: code.id, reason: why, actor: viewer.email, createdAt: now });
    return { ok: true, code: code.code };
  });
}
