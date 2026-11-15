"use server";

import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { dollarsToCents, formText, hhmmToMinutes } from "@/lib/parse";
import { CATALOG_TAG } from "@/server/cached";
import { blockPhotographer, savePhotoPackage, savePhotographerHours, unblockPhotographer } from "@/server/photography";
import { requireStaff } from "@/server/session";

/**
 * The photographer's working hours, their blocked time, and the packages.
 * Every action starts with `requireStaff`; the service then checks that this
 * viewer may do it (the owners, or staff the owners have allowed), because a
 * server action can be called directly.
 */
const PAGE = "/admin/photography";
const back = (kind: "notice" | "error", text: string): never => redirect(`${PAGE}?${kind}=${encodeURIComponent(text)}`);

export async function savePhotographerHoursAction(formData: FormData): Promise<void> {
  const viewer = await requireStaff(PAGE);
  // Check the whole week first, so that a bad row does not leave it half saved.
  const week: ({ openMinute: number; closeMinute: number } | null)[] = [];
  for (let weekday = 1; weekday <= 7; weekday++) {
    if (formData.get(`off:${weekday}`)) {
      week.push(null);
      continue;
    }
    const openMinute = hhmmToMinutes(formText(formData.get(`from:${weekday}`)));
    const closeMinute = hhmmToMinutes(formText(formData.get(`to:${weekday}`)));
    if (openMinute === null || closeMinute === null || openMinute >= closeMinute) {
      back("error", "Each working day needs a start time earlier than its end time.");
    }
    week.push({ openMinute: openMinute!, closeMinute: closeMinute! });
  }
  const db = await getDb();
  for (let weekday = 1; weekday <= 7; weekday++) {
    if (!(await savePhotographerHours(db, viewer, weekday, week[weekday - 1]))) back("error", "The hours could not be saved.");
  }
  back("notice", "Working hours saved. Customers are offered sessions inside them only.");
}

export async function blockPhotographerAction(formData: FormData): Promise<void> {
  const viewer = await requireStaff(PAGE);
  const startMinute = hhmmToMinutes(formText(formData.get("start")));
  const endMinute = hhmmToMinutes(formText(formData.get("end")));
  if (startMinute === null || endMinute === null) back("error", "Enter a start and an end time.");
  const result = await blockPhotographer(await getDb(), viewer, {
    date: formText(formData.get("date")),
    startMinute: startMinute!,
    endMinute: endMinute!,
    note: formText(formData.get("note")),
  });
  if (!result.ok) back("error", result.message);
  back("notice", "Time blocked. No session can be booked in it.");
}

export async function unblockPhotographerAction(formData: FormData): Promise<void> {
  const viewer = await requireStaff(PAGE);
  if (!(await unblockPhotographer(await getDb(), viewer, formText(formData.get("holdId"))))) {
    back("error", "That block could not be removed.");
  }
  back("notice", "Block removed. The time can be booked again.");
}

export async function savePhotoPackageAction(formData: FormData): Promise<void> {
  const viewer = await requireStaff(PAGE);
  const priceCents = dollarsToCents(formText(formData.get("price")));
  if (priceCents === null) back("error", "Enter the price as an amount, for example 375 or 375.50.");
  const saved = await savePhotoPackage(await getDb(), viewer, formText(formData.get("packageId")), {
    priceCents: priceCents!,
    includes: formText(formData.get("includes")),
    active: formData.get("onSale") !== null,
  });
  if (!saved) back("error", "The session could not be saved.");
  updateTag(CATALOG_TAG);
  back("notice", "Session saved. Sessions already booked keep what they were sold with.");
}
