import { randomInt } from "node:crypto";
import { and, eq, gt, gte, isNull, lt, or, sql } from "drizzle-orm";
import { promoCodes } from "@/db/schema";
import type { DbLike } from "@/db/client";
import type { PromoDef, PromoKind } from "@/lib/domain/pricing";

/**
 * Codes customers enter at checkout. Three kinds:
 *  - percent: a discount on the studio rental, usable `maxUses` times.
 *  - amount: money the customer already paid (a reschedule credit, or a pet
 *    fee returned as studio credit), or credit the studio gave. `value` is
 *    what is left on it and goes down as it is spent.
 *  - free_hour: the price of one hour of one studio, usable `maxUses` times
 *    (the loyalty reward: once). `value` is the free minutes, 60.
 */
export type PromoSource = "loyalty" | "reschedule" | "manual" | "pet_fee";

/** What an amount code is, in the customer's words: a moved booking's money, or credit from the studio. */
export function creditName(source: PromoSource): string {
  return source === "reschedule" ? "reschedule code" : "studio credit";
}

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
  /** For a free hour earned by visits: which one of the customer's it is. The database allows each once. */
  loyaltySeq?: number | null;
  note?: string;
  /** When it was issued: the moment of the change that issued it. The database's clock when left out. */
  issuedAt?: Date;
}

const PREFIX: Record<PromoSource, string> = { loyalty: "THANKS", reschedule: "MOVE", manual: "VS", pet_fee: "PET" };

/**
 * Create a new code. Returns null when the code already exists: one for the
 * same origin booking and source, or the same numbered free hour of the same
 * customer (the database allows only one of each), which makes issuing safe
 * to repeat.
 */
export async function issuePromo(tx: DbLike, given: IssuePromoInput): Promise<{ id: string; code: string } | null> {
  let input = given;
  const email = input.email ? input.email.trim().toLowerCase() : null;
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
        email,
        expiresAt: input.expiresAt,
        maxUses: input.maxUses ?? 1,
        rescheduleGeneration: input.rescheduleGeneration ?? 0,
        originBookingId: input.originBookingId ?? null,
        loyaltySeq: input.loyaltySeq ?? null,
        note: input.note ?? "",
        ...(input.issuedAt ? { createdAt: input.issuedAt } : {}),
      })
      .onConflictDoNothing()
      .returning({ id: promoCodes.id, code: promoCodes.code });
    if (rows[0]) return rows[0];

    if (input.loyaltySeq != null && email) {
      const numbered = await tx
        .select({ id: promoCodes.id })
        .from(promoCodes)
        .where(and(eq(promoCodes.email, email), eq(promoCodes.loyaltySeq, input.loyaltySeq)))
        .limit(1);
      if (numbered.length > 0) return null; // this free hour of this customer was already sent
    }
    if (input.originBookingId) {
      const existing = await tx
        .select({ id: promoCodes.id })
        .from(promoCodes)
        .where(and(eq(promoCodes.originBookingId, input.originBookingId), eq(promoCodes.source, input.source)))
        .limit(1);
      if (existing.length > 0) {
        if (input.loyaltySeq == null) return null; // already issued for this booking
        // The visit already stands for another of this customer's free hours (their stamps were corrected
        // since). This one is still owed: it is sent without naming a visit.
        input = { ...input, originBookingId: null };
        continue;
      }
    }
    // Otherwise the random code text collided with an existing one; try another.
  }
  throw new Error("Could not generate a unique code.");
}

/**
 * The reschedule code a booking's money went into when its customer released
 * it (`requestRescheduleCode`), while the owner has not cancelled it: what is
 * left on it is that money still. Null for a booking never released so.
 */
export async function rescheduleCodeOf(db: DbLike, bookingId: string): Promise<{ id: string; code: string; valueCents: number } | null> {
  const [code] = await db
    .select({ id: promoCodes.id, code: promoCodes.code, valueCents: promoCodes.value })
    .from(promoCodes)
    .where(and(eq(promoCodes.originBookingId, bookingId), eq(promoCodes.source, "reschedule"), isNull(promoCodes.voidedAt)))
    .limit(1);
  return code ?? null;
}

/**
 * Take a refund of a released booking off its reschedule code, in the
 * caller's transaction: the money comes back once, on the code or as a
 * refund. False when the code no longer holds that much (spent meanwhile).
 */
export async function takeOffRescheduleCode(tx: DbLike, codeId: string, cents: number): Promise<boolean> {
  const taken = await tx
    .update(promoCodes)
    .set({ value: sql`${promoCodes.value} - ${cents}` })
    .where(and(eq(promoCodes.id, codeId), gte(promoCodes.value, cents)))
    .returning({ id: promoCodes.id });
  return taken.length > 0;
}
