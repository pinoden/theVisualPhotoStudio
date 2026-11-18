"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { dollarsToCents, formText } from "@/lib/parse";
import { addPlan, savePlan, setPlanActive, type PlanInput } from "@/server/memberships";
import { requireOwner } from "@/server/session";

const PATH = "/admin/memberships";

function done(notice: string): never {
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
