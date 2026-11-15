import { randomInt } from "node:crypto";
import { and, eq, gt, gte, isNull, lt, or, sql } from "drizzle-orm";
import { promoCodes } from "@/db/schema";
import type { DbLike } from "@/db/client";
import type { PromoDef, PromoKind } from "@/lib/domain/pricing";

/**
 * Codes customers enter at checkout. Three kinds:
 *  - percent: a discount on the studio rental, usable `maxUses` times.
 *  - amount: money the customer already paid (a reschedule credit). `value`
 *    is what is left on it and goes down as it is spent.
 *  - free_hour: the price of one hour of one studio, usable `maxUses` times
 *    (the loyalty reward: once). `value` is the free minutes, 60.
 */
export type PromoSource = "loyalty" | "reschedule" | "manual";

export interface UsablePromo {
  id: string;
  code: string;
  kind: PromoKind;
  value: number;
  source: PromoSource;
  rescheduleGeneration: number;
}

export type PromoProblem = "not_found" | "expired" | "used_up" | "wrong_email";

export const PROMO_PROBLEM_TEXT: Record<PromoProblem, string> = {
  not_found: "That code is not valid.",
  expired: "That code has expired.",
  used_up: "That code has already been used.",
  wrong_email: "That code belongs to a different email address. Use the address the code was sent to.",
};

export function normalizeCode(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toUpperCase().replace(/\s+/g, "") : "";
}

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function randomCode(prefix: string): string {
  let body = "";
  for (let i = 0; i < 8; i++) body += ALPHABET[randomInt(ALPHABET.length)];
  return `${prefix}-${body.slice(0, 4)}-${body.slice(4)}`;
}

/** Look a code up for a customer. Does not consume it. */
export async function findUsablePromo(
  db: DbLike,
  rawCode: unknown,
  email: string,
  now: Date,
): Promise<{ ok: true; promo: UsablePromo } | { ok: false; problem: PromoProblem }> {
  const code = normalizeCode(rawCode);
  if (code.length < 4 || code.length > 40) return { ok: false, problem: "not_found" };
  const [row] = await db.select().from(promoCodes).where(eq(promoCodes.code, code)).limit(1);
  if (!row || row.voidedAt) return { ok: false, problem: "not_found" };
  if (row.email && row.email !== email.trim().toLowerCase()) return { ok: false, problem: "wrong_email" };
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return { ok: false, problem: "expired" };
  if (row.kind === "amount" ? row.value <= 0 : row.usedCount >= row.maxUses) return { ok: false, problem: "used_up" };
  return {
    ok: true,
    promo: {
      id: row.id,
      code: row.code,
      kind: row.kind,
      value: row.value,
      source: row.source,
      rescheduleGeneration: row.rescheduleGeneration,
    },
  };
}

export function toPromoDef(promo: UsablePromo): PromoDef {
  return { kind: promo.kind, value: promo.value };
}

export interface CustomerCode {
  code: string;
  kind: PromoKind;
  value: number;
  source: PromoSource;
  expiresAt: string | null;
}

/** The codes a customer can still use: the ones sent to their email address. */
export async function listCodesForEmail(db: DbLike, email: string, now: Date): Promise<CustomerCode[]> {
  const rows = await db
    .select()
    .from(promoCodes)
    .where(
      and(
        eq(promoCodes.email, email.trim().toLowerCase()),
        isNull(promoCodes.voidedAt),
        or(isNull(promoCodes.expiresAt), gt(promoCodes.expiresAt, now)),
      ),
    );
  return rows
    .filter((row) => (row.kind === "amount" ? row.value > 0 : row.usedCount < row.maxUses))
    .sort((a, b) => (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity))
    .map((row) => ({
      code: row.code,
      kind: row.kind,
      value: row.value,
      source: row.source,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    }));
}

/**
 * Spend a code as part of creating a booking. Runs inside the booking's
 * transaction. The conditions are checked again in the UPDATE itself, so two
 * bookings racing for the same code cannot both get it. Returns false when
 * the code can no longer cover `appliedCents`.
 */
export async function redeemPromo(tx: DbLike, promo: UsablePromo, appliedCents: number, now: Date): Promise<boolean> {
  const live = and(
    eq(promoCodes.id, promo.id),
    isNull(promoCodes.voidedAt),
    or(isNull(promoCodes.expiresAt), gt(promoCodes.expiresAt, now)),
  );
  const updated =
    promo.kind === "amount"
      ? await tx
          .update(promoCodes)
          .set({ value: sql`${promoCodes.value} - ${appliedCents}`, usedCount: sql`${promoCodes.usedCount} + 1` })
          .where(and(live, gte(promoCodes.value, appliedCents)))
          .returning({ id: promoCodes.id })
      : await tx
          .update(promoCodes)
          .set({ usedCount: sql`${promoCodes.usedCount} + 1` })
          .where(and(live, lt(promoCodes.usedCount, promoCodes.maxUses)))
          .returning({ id: promoCodes.id });
  return updated.length === 1;
}

/**
 * Undo `redeemPromo` after a booking did not go through (declined card,
 * cancellation). An amount code gets `appliedCents` back; the other kinds get
 * one use back.
 */
export async function restorePromo(tx: DbLike, promoId: string, kind: PromoKind, appliedCents: number): Promise<void> {
  await tx
    .update(promoCodes)
    .set(
      kind === "amount"
        ? { value: sql`${promoCodes.value} + ${appliedCents}`, usedCount: sql`greatest(${promoCodes.usedCount} - 1, 0)` }
        : { usedCount: sql`greatest(${promoCodes.usedCount} - 1, 0)` },
    )
    .where(eq(promoCodes.id, promoId));
}

export interface IssuePromoInput {
  kind: PromoKind;
  value: number;
  source: PromoSource;
  email: string | null;
  expiresAt: Date | null;
  maxUses?: number;
  rescheduleGeneration?: number;
  originBookingId?: string | null;
  note?: string;
}

const PREFIX: Record<PromoSource, string> = { loyalty: "THANKS", reschedule: "MOVE", manual: "VS" };

/**
 * Create a new code. Returns null when a code for the same origin booking and
 * source already exists (the database allows only one), which makes issuing
 * safe to repeat.
 */
export async function issuePromo(tx: DbLike, input: IssuePromoInput): Promise<{ id: string; code: string } | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    // ON CONFLICT DO NOTHING instead of catching an error: a failed statement
    // would abort the surrounding transaction.
    const rows = await tx
      .insert(promoCodes)
      .values({
        code: randomCode(PREFIX[input.source]),
        kind: input.kind,
        value: input.value,
        source: input.source,
        email: input.email ? input.email.trim().toLowerCase() : null,
        expiresAt: input.expiresAt,
        maxUses: input.maxUses ?? 1,
        rescheduleGeneration: input.rescheduleGeneration ?? 0,
        originBookingId: input.originBookingId ?? null,
        note: input.note ?? "",
      })
      .onConflictDoNothing()
      .returning({ id: promoCodes.id, code: promoCodes.code });
    if (rows[0]) return rows[0];

    if (input.originBookingId) {
      const existing = await tx
        .select({ id: promoCodes.id })
        .from(promoCodes)
        .where(and(eq(promoCodes.originBookingId, input.originBookingId), eq(promoCodes.source, input.source)))
        .limit(1);
      if (existing.length > 0) return null; // already issued for this booking
    }
    // Otherwise the random code text collided with an existing one; try another.
  }
  throw new Error("Could not generate a unique code.");
}
