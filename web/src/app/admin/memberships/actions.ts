"use server";

import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { dollarsToCents, formText } from "@/lib/parse";
import { CATALOG_TAG } from "@/server/cached";
import { addPlan, cancelMembership, correctMinutes, savePlan, setPlanActive, type PlanInput } from "@/server/memberships";
import { resolvePayments } from "@/server/payments";
import { flushEmailsSoon, siteUrl } from "@/server/runtime";
import type { CancelMembershipState } from "@/app/account/membership/actions";
import { requireOwner } from "@/server/session";

const PATH = "/admin/memberships";

/** Back to the page with a message. The plans on sale travel with the public catalog, which is made again. */
function done(notice: string): never {
  updateTag(CATALOG_TAG);
  redirect(`${PATH}?notice=${encodeURIComponent(notice)}`);
}

function failed(error: string): never {
  redirect(`${PATH}?error=${encodeURIComponent(error)}`);
}

const text = (formData: FormData, name: string) => formText(formData.get(name));

/** The plan's fields as typed: hours a month as whole or half hours, the price in dollars. */
function planInput(formData: FormData): PlanInput {
  const hours = Number(text(formData, "hours"));
  const priceCents = dollarsToCents(text(formData, "price"));
  if (priceCents === null) failed("Enter the price of a month as an amount up to $10,000, for example 330 or 330.50.");
  return {
    name: text(formData, "name"),
    description: text(formData, "description"),
    minutes: Number.isFinite(hours) ? Math.round(hours * 60) : Number.NaN,
    priceCents,
  };
}

export async function savePlanAction(formData: FormData): Promise<void> {
  await requireOwner(PATH);
  const result = await savePlan(await getDb(), text(formData, "planId"), planInput(formData));
  if (!result.ok) failed(result.message);
  done("Plan saved. A new price or number of hours applies to members who join after it.");
}

export async function addPlanAction(formData: FormData): Promise<void> {
  await requireOwner(PATH);
  const studioIds = text(formData, "studios").split(",").filter(Boolean);
  const result = await addPlan(await getDb(), studioIds, planInput(formData));
  if (!result.ok) failed(result.message);
  done("Plan added.");
}

// Two actions rather than one with a named button: a button whose formAction is a function cannot carry a name.
export async function stopOfferingPlanAction(formData: FormData): Promise<void> {
  await requireOwner(PATH);
  if (!(await setPlanActive(await getDb(), text(formData, "planId"), false))) failed("Unknown plan.");
  done("The plan is no longer offered. Its members keep it.");
}

export async function offerPlanAgainAction(formData: FormData): Promise<void> {
  await requireOwner(PATH);
  if (!(await setPlanActive(await getDb(), text(formData, "planId"), true))) failed("Unknown plan.");
  done("The plan is offered again.");
}

// ── A member's page ──────────────────────────────────────────────────────────

const memberPath = (id: string) => `/admin/memberships/members/${encodeURIComponent(id)}`;

/** An owner adds hours to a membership, or takes some away, with a reason (`correctMinutes`). */
export async function correctMinutesAction(formData: FormData): Promise<void> {
  const id = text(formData, "membershipId");
  const viewer = await requireOwner(memberPath(id));
  const hours = Number(text(formData, "hours"));
  const result = await correctMinutes(await getDb(), viewer, id, { minutes: Number.isFinite(hours) ? Math.round(hours * 60) : Number.NaN, reason: text(formData, "reason") });
  updateTag(CATALOG_TAG);
  redirect(`${memberPath(id)}?${result.ok ? "notice" : "error"}=${encodeURIComponent(result.ok ? "Hours changed. The member sees them in their account." : result.message)}`);
}

/** An owner cancels a membership for its member: the same as the member's own "Cancel membership". */
export async function cancelMemberAction(_previous: CancelMembershipState, formData: FormData): Promise<CancelMembershipState> {
  const id = String(formData.get("membershipId") ?? "");
  const viewer = await requireOwner(memberPath(id));
  const result = await cancelMembership(await getDb(), viewer, id, { now: new Date(), payments: resolvePayments().provider, baseUrl: await siteUrl() });
  if (!result.ok) return { status: "error", message: result.message };
  flushEmailsSoon();
  redirect(`${memberPath(id)}?notice=${encodeURIComponent("Membership cancelled. No more monthly payments will be taken, and the member was emailed.")}`);
}
