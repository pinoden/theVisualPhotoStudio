import { asc, eq, inArray } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { membershipPlans, membershipPlanStudios, studios } from "@/db/schema";
import { studioCombinationError } from "@/lib/catalog-view";

/**
 * Memberships (follow-up 3; the owners' answers of 2026-11-17 and 2026-11-18, recorded under follow-up 3 in
 * ProjectLibrary.md, with the plan they are built by). A plan gives studio minutes each month for a monthly price, in
 * one studio or in the studios of a bundle, each of which the minutes can be spent in alone too. The owners add plans,
 * change them and switch them on and off; a plan is never deleted, as the memberships sold refer to it.
 */

export const PLAN_NAME_MAX = 80;
export const PLAN_DESCRIPTION_MAX = 500;
/** A plan gives whole or half hours: from half an hour to 100 hours a month. */
export const PLAN_MINUTES_RANGE = [30, 6000] as const;
/** At most $10,000 a month. */
export const PLAN_PRICE_MAX_CENTS = 1_000_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PlanInput {
  name: string;
  description: string;
  /** Studio minutes each month. */
  minutes: number;
  /** The price of a month. */
  priceCents: number;
}

export interface PlanView extends PlanInput {
  id: string;
  active: boolean;
  /** Its studios, in the studios' own order. */
  studios: { id: string; name: string; slug: string }[];
}

/** Every plan, those no longer offered too, in the owners' order. */
export async function listPlans(db: DbLike): Promise<PlanView[]> {
  const plans = await db.select().from(membershipPlans).orderBy(asc(membershipPlans.sortOrder), asc(membershipPlans.createdAt));
  const links = await db
    .select({ planId: membershipPlanStudios.planId, id: studios.id, name: studios.name, slug: studios.slug })
    .from(membershipPlanStudios)
    .innerJoin(studios, eq(studios.id, membershipPlanStudios.studioId))
    .orderBy(asc(studios.sortOrder));
  return plans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    description: plan.description,
    minutes: plan.minutes,
    priceCents: plan.priceCents,
    active: plan.active,
    studios: links.filter((link) => link.planId === plan.id).map(({ id, name, slug }) => ({ id, name, slug })),
  }));
}

export type SavePlanResult = { ok: true; id: string } | { ok: false; message: string };

function planProblem(input: PlanInput): string | null {
  const name = input.name.replace(/\s+/g, " ").trim();
  if (name.length < 1 || name.length > PLAN_NAME_MAX) return `Give the plan a name of up to ${PLAN_NAME_MAX} characters.`;
  if (input.description.trim().length > PLAN_DESCRIPTION_MAX) return `Keep the description under ${PLAN_DESCRIPTION_MAX} characters.`;
  const [least, most] = PLAN_MINUTES_RANGE;
  if (!Number.isInteger(input.minutes) || input.minutes < least || input.minutes > most || input.minutes % 30 !== 0) {
    return "Give the hours a month as whole or half hours, from 0.5 to 100.";
  }
  if (!Number.isInteger(input.priceCents) || input.priceCents <= 0 || input.priceCents > PLAN_PRICE_MAX_CENTS) {
    return "Enter the price of a month as an amount up to $10,000, for example 330 or 330.50.";
  }
  return null;
}

/**
 * Change a plan's name, description, hours or price. Its studios stay as they were made: they are what its members
 * bought. A new price or number of hours applies to the members who join after it (step 2 keeps each member's own).
 */
export async function savePlan(db: DbLike, planId: string, input: PlanInput): Promise<SavePlanResult> {
  const problem = planProblem(input);
  if (problem) return { ok: false, message: problem };
  if (!UUID.test(planId)) return { ok: false, message: "Unknown plan." };
  const updated = await db
    .update(membershipPlans)
    .set({ name: input.name.replace(/\s+/g, " ").trim(), description: input.description.trim(), minutes: input.minutes, priceCents: input.priceCents })
    .where(eq(membershipPlans.id, planId))
    .returning({ id: membershipPlans.id });
  return updated.length === 1 ? { ok: true, id: planId } : { ok: false, message: "Unknown plan." };
}

/** Add a plan, offered at once, after the others. Its studios are those that can be booked together. */
export async function addPlan(db: DbLike, studioIds: readonly string[], input: PlanInput): Promise<SavePlanResult> {
  const problem = planProblem(input);
  if (problem) return { ok: false, message: problem };
  const chosen = [...new Set(studioIds)];
  if (chosen.length === 0 || chosen.length !== studioIds.length || !chosen.every((studioId) => UUID.test(studioId))) {
    return { ok: false, message: "Choose the studio, or the studios of a bundle, the plan is for." };
  }
  const known = await db.select({ id: studios.id, slug: studios.slug }).from(studios).where(inArray(studios.id, chosen));
  if (known.length !== chosen.length) return { ok: false, message: "Unknown studio." };
  const together = studioCombinationError(known, chosen);
  if (together) return { ok: false, message: `A plan is for studios that can be booked together. ${together}` };

  const orders = await db.select({ sortOrder: membershipPlans.sortOrder }).from(membershipPlans);
  const [plan] = await db
    .insert(membershipPlans)
    .values({
      name: input.name.replace(/\s+/g, " ").trim(),
      description: input.description.trim(),
      minutes: input.minutes,
      priceCents: input.priceCents,
      sortOrder: Math.max(-1, ...orders.map((row) => row.sortOrder)) + 1,
    })
    .returning({ id: membershipPlans.id });
  await db.insert(membershipPlanStudios).values(chosen.map((studioId) => ({ planId: plan.id, studioId })));
  return { ok: true, id: plan.id };
}

/** Offer a plan, or stop offering it: its members keep it. */
export async function setPlanActive(db: DbLike, planId: string, active: boolean): Promise<boolean> {
  if (!UUID.test(planId)) return false;
  const updated = await db.update(membershipPlans).set({ active }).where(eq(membershipPlans.id, planId)).returning({ id: membershipPlans.id });
  return updated.length === 1;
}

/**
 * The studios a plan can be for, in the studios' order: each studio alone, and every set of studios that can be
 * booked together (not Blanche and Dayglow without Paris).
 */
export function planStudioChoices(all: readonly { id: string; name: string; slug: string }[]): { ids: string[]; label: string }[] {
  const sets: { id: string; name: string; slug: string }[][] = [];
  for (let mask = 1; mask < 1 << all.length; mask++) sets.push(all.filter((_, index) => (mask & (1 << index)) !== 0));
  return sets
    .filter((set) => studioCombinationError(set, set.map((studio) => studio.id)) === null)
    .sort((a, b) => a.length - b.length)
    .map((set) => ({
      ids: set.map((studio) => studio.id),
      label: set.length === all.length && all.length > 2 ? "All the studios" : set.map((studio) => studio.name).join(" and "),
    }));
}
