"use server";

import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/domain/pricing";
import { dollarsToCents, formText, hhmmToMinutes } from "@/lib/parse";
import { PRICE_MAX_CENTS } from "@/server/admin";
import { CATALOG_TAG, WEBSITE_TAG } from "@/server/cached";
import { blockPhotographer, blockPhotographerDays, daysText, savePhotoPackage, savePhotographerHours, unblockPhotographer } from "@/server/photography";
import { addPhotographyPhotos, movePhotographyPhoto, removePhotographyPhoto } from "@/server/photography-photos";
import { requireOwner, requireStaff } from "@/server/session";

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

/** Whole days off: one day, or several in a row (the owner's answer of 2026-11-23, question 70). */
export async function blockPhotographerDaysAction(formData: FormData): Promise<void> {
  const viewer = await requireStaff(PAGE);
  const from = formText(formData.get("from"));
  const to = formText(formData.get("to"));
  const result = await blockPhotographerDays(await getDb(), viewer, { from, to, note: formText(formData.get("note")) }, new Date());
  if (!result.ok) back("error", result.message);
  back("notice", `The photographer is off on ${daysText({ from, to: to || from })}: no session can be booked then.`);
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
  if (priceCents! > PRICE_MAX_CENTS) back("error", `A price can be at most ${formatCents(PRICE_MAX_CENTS)}.`);
  const saved = await savePhotoPackage(await getDb(), viewer, formText(formData.get("packageId")), {
    priceCents: priceCents!,
    includes: formText(formData.get("includes")),
    active: formData.get("onSale") !== null,
  });
  if (!saved) back("error", "The session could not be saved.");
  updateTag(CATALOG_TAG);
  back("notice", "Session saved. Sessions already booked keep what they were sold with.");
}

// ── The photos the site shows for photography (question 73) ──────────────────

const PHOTOS = (kind: "notice" | "error", text: string): never => redirect(`${PAGE}?${kind}=${encodeURIComponent(text)}#photography-photos`);

export async function addPhotographyPhotosAction(formData: FormData): Promise<void> {
  const viewer = await requireOwner(PAGE);
  const result = await addPhotographyPhotos(await getDb(), viewer, formText(formData.get("mediaIds")).split(","));
  if (!result.ok) PHOTOS("error", result.message);
  updateTag(WEBSITE_TAG);
  PHOTOS("notice", "Photos added. The website shows them now.");
}

export async function removePhotographyPhotoAction(formData: FormData): Promise<void> {
  const viewer = await requireOwner(PAGE);
  const result = await removePhotographyPhoto(await getDb(), viewer, formText(formData.get("mediaId")));
  if (!result.ok) PHOTOS("error", result.message);
  updateTag(WEBSITE_TAG);
  PHOTOS("notice", "The photo was taken off. It is still in the media library.");
}

async function movePhotographyPhotoBy(formData: FormData, by: -1 | 1): Promise<void> {
  const viewer = await requireOwner(PAGE);
  const result = await movePhotographyPhoto(await getDb(), viewer, formText(formData.get("mediaId")), by);
  if (!result.ok) PHOTOS("error", result.message);
  updateTag(WEBSITE_TAG);
  PHOTOS("notice", "Order saved.");
}

export async function movePhotographyPhotoEarlierAction(formData: FormData): Promise<void> {
  await movePhotographyPhotoBy(formData, -1);
}

export async function movePhotographyPhotoLaterAction(formData: FormData): Promise<void> {
  await movePhotographyPhotoBy(formData, 1);
}
