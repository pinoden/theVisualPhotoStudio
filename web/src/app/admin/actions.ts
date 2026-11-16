"use server";

import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { isAddonKind } from "@/lib/addon-kinds";
import { dollarsToCents, formText, hhmmToMinutes, intInRange } from "@/lib/parse";
import { ADMIN_LEVELS, ATTENDANT_SWITCH_KEYS, isAdminLevel, MANAGER_SWITCH_KEYS } from "@/lib/abilities";
import { formatCents } from "@/lib/domain/pricing";
import {
  addStaff,
  createBlock,
  createManualCode,
  removeBlock,
  removeStaff,
  saveAddon,
  savePrice,
  saveStudioDetails,
  saveStudioHours,
  setAddonActive,
  setShift,
  setSpecialDate,
  setStaffLevel,
  voidCode,
} from "@/server/admin";
import { CATALOG_TAG } from "@/server/cached";
import { FREE_HOUR_MINUTES } from "@/server/loyalty";
import { ownerCancelBooking, ownerRefund, recordRefundMadeInSquare } from "@/server/manage";
import { flushEmailsSoon, manageDeps } from "@/server/runtime";
import { notFound } from "next/navigation";
import { can, type Ability } from "@/lib/abilities";
import { requireManager, requireOwner } from "@/server/session";
import { ACCESS_INSTRUCTIONS_MAX, loadSettings, NUMBER_SETTING_RANGES, saveAccessInstructions, saveSetting, type NumberSettingKey } from "@/server/settings";
import { settingLabel } from "./settings/fields";
import { addStudioPhotos, moveStudioPhoto, removeStudioPhoto, setStudioFloorPlan } from "@/server/studio-photos";
import { includedList } from "@/lib/studio-facts";

/**
 * Everything the owners can change. Every action starts with `requireOwner`:
 * server actions can be called directly, so the page's own check is not
 * enough. Four of them (blocking time, cancelling and refunding) start with
 * `requireAbility` instead, because the owners can give those to managers.
 * Each finishes by redirecting back with a short message in the address.
 */
function done(path: string, notice: string): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}notice=${encodeURIComponent(notice)}`);
}

function failed(path: string, error: string): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(error)}`);
}

const text = (formData: FormData, name: string) => formText(formData.get(name));

/**
 * For the few things here that a manager can be given: an owner, or a manager
 * for whom the owners have switched `ability` on. Anyone else gets "not found".
 */
async function requireAbility(ability: Ability, next: string): Promise<void> {
  const viewer = await requireManager(next);
  if (!can(viewer, ability, await loadSettings(await getDb()))) notFound();
}

/** Where to return after a bookings action. Only the bookings list itself is accepted. */
function bookingsBack(formData: FormData): string {
  const back = text(formData, "back");
  return /^\/admin\/bookings(\?[A-Za-z0-9=&%_.-]*)?$/.test(back) ? back : "/admin/bookings";
}

// ── Staff ────────────────────────────────────────────────────────────────────

export async function addStaffAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/staff");
  const level = text(formData, "level") || "staff";
  if (!isAdminLevel(level)) failed("/admin/staff", "Choose Studio Manager or Studio Attendant.");
  const result = await addStaff(await getDb(), text(formData, "email"), text(formData, "name"), level);
  if (!result.ok) failed("/admin/staff", result.message);
  done("/admin/staff", `Staff member added as ${ADMIN_LEVELS[level]}. They sign in with their email address.`);
}

/** Make an attendant a manager, or a manager an attendant. It applies at their next request. */
export async function setStaffLevelAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/staff");
  const level = text(formData, "level");
  if (!isAdminLevel(level) || !(await setStaffLevel(await getDb(), text(formData, "userId"), level))) {
    failed("/admin/staff", "That could not be changed.");
  }
  done("/admin/staff", `Saved: ${ADMIN_LEVELS[level]} from now on.`);
}

/** The owners' switches for attendants. A box that is not ticked switches the ability off. */
export async function saveStaffAbilitiesAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/staff");
  const db = await getDb();
  for (const ability of ATTENDANT_SWITCH_KEYS) {
    if (!(await saveSetting(db, ability, formData.get(ability) !== null))) failed("/admin/staff", "That could not be saved.");
  }
  updateTag(CATALOG_TAG); // the settings travel with the catalog
  done("/admin/staff", "Saved. It applies to every Studio Attendant from now on.");
}

/** The owners' switches for managers. A box that is not ticked switches the ability off. */
export async function saveManagerAbilitiesAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/staff");
  const db = await getDb();
  for (const ability of MANAGER_SWITCH_KEYS) {
    if (!(await saveSetting(db, ability, formData.get(ability) !== null))) failed("/admin/staff", "That could not be saved.");
  }
  updateTag(CATALOG_TAG);
  done("/admin/staff", "Saved. It applies to every Studio Manager from now on.");
}

export async function removeStaffAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/staff");
  await removeStaff(await getDb(), text(formData, "userId"));
  done("/admin/staff", "Staff access removed.");
}

export async function shiftAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/staff");
  const ok = await setShift(await getDb(), text(formData, "userId"), text(formData, "day"), text(formData, "assigned") === "1");
  if (!ok) failed("/admin/staff", "Choose a valid date.");
  done("/admin/staff", text(formData, "assigned") === "1" ? "Day assigned." : "Day removed.");
}

// ── Prices ───────────────────────────────────────────────────────────────────

/** Save a studio's whole price table: fields named price:<dayType>:<minutes>. An empty field removes that price. */
export async function savePricesAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/prices");
  const db = await getDb();
  const studioId = text(formData, "studioId");
  const changes: { dayType: "weekday" | "weekend"; durationMinutes: number; priceCents: number | null }[] = [];
  for (const [name, value] of formData.entries()) {
    const match = /^price:(weekday|weekend):(\d+)$/.exec(name);
    if (!match || typeof value !== "string") continue;
    const priceCents = value.trim() === "" ? null : dollarsToCents(value);
    if (value.trim() !== "" && priceCents === null) failed("/admin/prices", `"${value}" is not a valid price.`);
    changes.push({ dayType: match[1] as "weekday" | "weekend", durationMinutes: Number(match[2]), priceCents });
  }
  for (const change of changes) {
    if (!(await savePrice(db, { studioId, ...change }))) failed("/admin/prices", "A price could not be saved.");
  }
  updateTag(CATALOG_TAG);
  done("/admin/prices", "Prices saved.");
}

export async function addDurationAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/prices");
  const minutes = intInRange(text(formData, "minutes"), 15, 1440);
  const weekday = dollarsToCents(text(formData, "weekday"));
  const weekendRaw = text(formData, "weekend");
  const weekend = weekendRaw === "" ? weekday : dollarsToCents(weekendRaw);
  if (minutes === null || weekday === null || weekend === null) {
    failed("/admin/prices", "Enter a duration and a price. Durations are in steps of 15 minutes.");
  }
  const db = await getDb();
  const studioId = text(formData, "studioId");
  const a = await savePrice(db, { studioId, dayType: "weekday", durationMinutes: minutes, priceCents: weekday });
  const b = await savePrice(db, { studioId, dayType: "weekend", durationMinutes: minutes, priceCents: weekend });
  if (!a || !b) failed("/admin/prices", "That duration could not be added. Durations are in steps of 15 minutes.");
  updateTag(CATALOG_TAG);
  done("/admin/prices", "Duration added.");
}

export async function saveDiscountAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/prices");
  const two = intInRange(text(formData, "two"), 0, 100);
  const three = intInRange(text(formData, "three"), 0, 100);
  if (two === null || three === null) failed("/admin/prices", "Discounts are whole percentages from 0 to 100.");
  await saveSetting(await getDb(), "multiStudioPercent", { 2: two, 3: three });
  updateTag(CATALOG_TAG);
  done("/admin/prices", "Multi-studio discount saved.");
}

export async function specialDateAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/prices");
  const dayType = text(formData, "dayType");
  const ok = await setSpecialDate(
    await getDb(),
    text(formData, "day"),
    dayType === "weekday" || dayType === "weekend" ? dayType : null,
    text(formData, "note"),
  );
  if (!ok) failed("/admin/prices", "Choose a valid date.");
  updateTag(CATALOG_TAG);
  done("/admin/prices", dayType === "clear" ? "Date returned to its normal pricing." : "Special date saved.");
}

// ── Hours and blocked time ───────────────────────────────────────────────────

export async function saveHoursAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/hours");
  const db = await getDb();
  const studioId = text(formData, "studioId");
  // Check everything first so a bad row does not leave the week half-saved.
  const week: ({ openMinute: number; closeMinute: number } | null)[] = [];
  for (let weekday = 1; weekday <= 7; weekday++) {
    if (formData.get(`closed:${weekday}`)) {
      week.push(null);
      continue;
    }
    const openMinute = hhmmToMinutes(text(formData, `open:${weekday}`));
    const closeMinute = hhmmToMinutes(text(formData, `close:${weekday}`));
    if (openMinute === null || closeMinute === null || openMinute >= closeMinute) {
      failed("/admin/hours", "Each open day needs an opening time earlier than its closing time.");
    }
    week.push({ openMinute, closeMinute });
  }
  for (let weekday = 1; weekday <= 7; weekday++) {
    if (!(await saveStudioHours(db, studioId, weekday, week[weekday - 1]))) failed("/admin/hours", "Hours could not be saved.");
  }
  updateTag(CATALOG_TAG);
  done("/admin/hours", "Opening hours saved.");
}

export async function createBlockAction(formData: FormData): Promise<void> {
  await requireAbility("blockTime", "/admin/hours");
  const startMinute = hhmmToMinutes(text(formData, "start"));
  const endMinute = hhmmToMinutes(text(formData, "end"));
  if (startMinute === null || endMinute === null) failed("/admin/hours", "Enter a start and an end time.");
  const result = await createBlock(await getDb(), {
    studioIds: formData.getAll("studio").filter((v): v is string => typeof v === "string"),
    date: text(formData, "date"),
    startMinute,
    endMinute,
    note: text(formData, "note"),
  });
  if (!result.ok) failed("/admin/hours", result.message);
  done("/admin/hours", "Time blocked.");
}

export async function removeBlockAction(formData: FormData): Promise<void> {
  await requireAbility("blockTime", "/admin/hours");
  await removeBlock(await getDb(), text(formData, "blockId"));
  done("/admin/hours", "Block removed.");
}

// ── Bookings ─────────────────────────────────────────────────────────────────

const refundNote = (refund: "sent" | "pending" | "none", cents: number) =>
  refund === "none"
    ? "No refund."
    : refund === "sent"
      ? `${formatCents(cents)} refunded to the card.`
      : `${formatCents(cents)} refund recorded; it has not gone through yet and will be retried.`;

export async function ownerCancelAction(formData: FormData): Promise<void> {
  const back = bookingsBack(formData);
  await requireAbility("refund", "/admin/bookings");
  const refundCents = dollarsToCents(text(formData, "refund") || "0");
  if (refundCents === null) failed(back, "Enter the refund as an amount, for example 88 or 88.50.");
  const result = await ownerCancelBooking(await getDb(), text(formData, "ref"), { refundCents }, await manageDeps());
  flushEmailsSoon();
  if (!result.ok) failed(back, result.message);
  done(back, `Booking cancelled. ${refundNote(result.refund, result.refundCents)}`);
}

/** The owner refunded a payment by hand in Square after the site could not: the site stops trying, and counts it as made. */
export async function recordRefundMadeInSquareAction(formData: FormData): Promise<void> {
  const owner = await requireOwner("/admin");
  const result = await recordRefundMadeInSquare(await getDb(), owner, text(formData, "refundId"), new Date());
  if (!result.ok) failed("/admin", result.message);
  done("/admin", "Recorded: the refund was made in Square. The site no longer tries to make it.");
}

export async function ownerRefundAction(formData: FormData): Promise<void> {
  const back = bookingsBack(formData);
  await requireAbility("refund", "/admin/bookings");
  const amountCents = dollarsToCents(text(formData, "amount"));
  if (amountCents === null) failed(back, "Enter the refund as an amount, for example 25 or 25.50.");
  const result = await ownerRefund(
    await getDb(),
    text(formData, "ref"),
    { amountCents, reason: text(formData, "reason") },
    await manageDeps(),
  );
  flushEmailsSoon();
  if (!result.ok) failed(back, result.message);
  done(back, refundNote(result.refund, result.refundCents));
}

// ── Codes ────────────────────────────────────────────────────────────────────

export async function createCodeAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/codes");
  const chosen = text(formData, "kind");
  const kind = chosen === "amount" || chosen === "free_hour" ? chosen : "percent";
  // A free hour needs no value: it is always the price of one hour.
  const value =
    kind === "free_hour"
      ? FREE_HOUR_MINUTES
      : kind === "amount"
        ? dollarsToCents(text(formData, "value"))
        : intInRange(text(formData, "value"), 1, 100);
  const validDays = intInRange(text(formData, "validDays"), 1, 730);
  const maxUses = kind === "amount" ? 1 : intInRange(text(formData, "maxUses") || "1", 1, 100000);
  if (value === null || validDays === null || maxUses === null) {
    failed("/admin/codes", "Check the value, the number of days and the number of uses.");
  }
  const result = await createManualCode(
    await getDb(),
    { kind, value, email: text(formData, "email") || null, validDays, maxUses, note: text(formData, "note") },
    new Date(),
  );
  if (!result.ok) failed("/admin/codes", result.message);
  done("/admin/codes", `Code created: ${result.code}`);
}

export async function voidCodeAction(formData: FormData): Promise<void> {
  const owner = await requireOwner("/admin/codes");
  await voidCode(await getDb(), text(formData, "codeId"), new Date(), owner.email);
  done("/admin/codes", "Code cancelled. It can no longer be used.");
}

// ── Settings ─────────────────────────────────────────────────────────────────

const NUMBER_SETTINGS = Object.keys(NUMBER_SETTING_RANGES) as NumberSettingKey[];
// What staff can do is set on the Staff page (saveStaffAbilitiesAction), not here.
const SWITCH_SETTINGS = ["loyaltyEnabled"] as const;

export async function saveSettingsAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/settings");
  const db = await getDb();
  const rejected: string[] = [];
  for (const key of NUMBER_SETTINGS) {
    const value = intInRange(text(formData, key), 0, 100000);
    if (value === null || !(await saveSetting(db, key, value))) {
      const [min, max] = NUMBER_SETTING_RANGES[key];
      rejected.push(`${settingLabel(key)} is a whole number from ${min} to ${max}`);
    }
  }
  for (const key of SWITCH_SETTINGS) {
    if (!(await saveSetting(db, key, formData.get(key) !== null))) rejected.push(key);
  }
  updateTag(CATALOG_TAG);
  if (rejected.length > 0) {
    failed("/admin/settings", `Not saved: ${rejected.join("; ")}. Everything else was saved.`);
  }
  done("/admin/settings", "Settings saved.");
}

export async function saveAccessInstructionsAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/settings");
  const instructions = text(formData, "accessInstructions");
  if (!(await saveAccessInstructions(await getDb(), instructions))) {
    failed("/admin/settings", `Not saved: the text is longer than ${ACCESS_INSTRUCTIONS_MAX} characters.`);
  }
  updateTag(CATALOG_TAG); // the guest information page says whether this is sent
  done(
    "/admin/settings",
    instructions === ""
      ? "Saved. No getting-in text is sent or shown any more."
      : "Saved. New confirmation emails and the page of every confirmed booking that has not ended now show it.",
  );
}

// ── Studios and add-ons ──────────────────────────────────────────────────────

export async function saveStudioDetailsAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/studios");
  const includedGuests = intInRange(text(formData, "includedGuests"), 1, 100);
  const bufferMinutes = intInRange(text(formData, "bufferMinutes"), 0, 240);
  if (includedGuests === null || bufferMinutes === null) {
    failed("/admin/studios", "Not saved: guests must be 1 to 100, and clean-up time 0 to 240 minutes.");
  }
  const saved = await saveStudioDetails(await getDb(), text(formData, "studioId"), {
    tagline: text(formData, "tagline"),
    description: text(formData, "description"),
    includedGuests,
    bufferMinutes,
    facts: {
      size: text(formData, "size"),
      ceiling: text(formData, "ceiling"),
      light: text(formData, "light"),
      cyclorama: text(formData, "cyclorama"),
      included: includedList(formText(formData.get("included"))),
    },
  });
  if (!saved) failed("/admin/studios", "Not saved: the tagline or the description is too long.");
  updateTag(CATALOG_TAG);
  done("/admin/studios", "Studio saved.");
}

/** Choose a studio's floor plan: the first of `mediaIds`, as the chooser sends them. */
export async function setStudioFloorPlanAction(formData: FormData): Promise<void> {
  const viewer = await requireOwner("/admin/studios");
  const result = await setStudioFloorPlan(await getDb(), viewer, text(formData, "studioId"), text(formData, "mediaIds").split(",")[0] ?? "");
  if (!result.ok) failed("/admin/studios", result.message);
  updateTag(CATALOG_TAG);
  done("/admin/studios", "Floor plan chosen. Customers see it now.");
}

export async function removeStudioFloorPlanAction(formData: FormData): Promise<void> {
  const viewer = await requireOwner("/admin/studios");
  const result = await setStudioFloorPlan(await getDb(), viewer, text(formData, "studioId"), "");
  if (!result.ok) failed("/admin/studios", result.message);
  updateTag(CATALOG_TAG);
  done("/admin/studios", "Floor plan taken away.");
}

/** Add pictures of the media library to a studio's photos. `mediaIds` is their ids with commas between, as the chooser sends them. */
export async function addStudioPhotosAction(formData: FormData): Promise<void> {
  const viewer = await requireOwner("/admin/studios");
  const result = await addStudioPhotos(await getDb(), viewer, text(formData, "studioId"), text(formData, "mediaIds").split(","));
  if (!result.ok) failed("/admin/studios", result.message);
  updateTag(CATALOG_TAG);
  done("/admin/studios", "Photos added. Customers see them now.");
}

export async function removeStudioPhotoAction(formData: FormData): Promise<void> {
  const viewer = await requireOwner("/admin/studios");
  const result = await removeStudioPhoto(await getDb(), viewer, text(formData, "studioId"), text(formData, "mediaId"));
  if (!result.ok) failed("/admin/studios", result.message);
  updateTag(CATALOG_TAG);
  done("/admin/studios", "The photo was taken off the studio. It is still in the media library.");
}

async function moveStudioPhotoBy(formData: FormData, by: -1 | 1): Promise<void> {
  const viewer = await requireOwner("/admin/studios");
  const result = await moveStudioPhoto(await getDb(), viewer, text(formData, "studioId"), text(formData, "mediaId"), by);
  if (!result.ok) failed("/admin/studios", result.message);
  updateTag(CATALOG_TAG);
  redirect("/admin/studios");
}

export async function moveStudioPhotoEarlierAction(formData: FormData): Promise<void> {
  await moveStudioPhotoBy(formData, -1);
}

export async function moveStudioPhotoLaterAction(formData: FormData): Promise<void> {
  await moveStudioPhotoBy(formData, 1);
}

export async function saveAddonAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/studios");
  const priceCents = dollarsToCents(text(formData, "price"));
  const kind = text(formData, "kind");
  if (priceCents === null) failed("/admin/studios", "Enter the price as an amount, for example 40 or 40.50.");
  if (!isAddonKind(kind)) failed("/admin/studios", "Choose what the add-on is for.");
  const addonId = text(formData, "addonId") || null;
  const result = await saveAddon(await getDb(), addonId, {
    name: text(formData, "name"),
    description: text(formData, "description"),
    priceCents,
    kind,
    studioId: text(formData, "studioId") || null,
  });
  if (!result.ok) failed("/admin/studios", result.message);
  updateTag(CATALOG_TAG);
  done("/admin/studios", addonId ? "Add-on saved." : "Add-on added.");
}

async function offerAddon(formData: FormData, active: boolean): Promise<void> {
  await requireOwner("/admin/studios");
  if (!(await setAddonActive(await getDb(), text(formData, "addonId"), active))) {
    failed("/admin/studios", "Unknown add-on.");
  }
  updateTag(CATALOG_TAG);
  done(
    "/admin/studios",
    active ? "The add-on is offered again." : "The add-on is no longer offered. Bookings that already have it keep it.",
  );
}

// Two actions rather than one with a named button: a button whose formAction is a function cannot carry a name.
export async function stopOfferingAddonAction(formData: FormData): Promise<void> {
  await offerAddon(formData, false);
}

export async function offerAddonAgainAction(formData: FormData): Promise<void> {
  await offerAddon(formData, true);
}
