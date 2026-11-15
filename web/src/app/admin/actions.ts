"use server";

import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { dollarsToCents, hhmmToMinutes, intInRange } from "@/lib/parse";
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
  voidCode,
} from "@/server/admin";
import { CATALOG_TAG } from "@/server/cached";
import { ownerCancelBooking, ownerRefund } from "@/server/manage";
import { flushEmailsSoon, manageDeps } from "@/server/runtime";
import { requireOwner } from "@/server/session";
import { ACCESS_INSTRUCTIONS_MAX, saveAccessInstructions, saveSetting } from "@/server/settings";

/**
 * Everything the owner can change. Every action starts with `requireOwner`:
 * server actions can be called directly, so the page's own check is not enough.
 * Each finishes by redirecting back with a short message in the address.
 */
function done(path: string, notice: string): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}notice=${encodeURIComponent(notice)}`);
}

function failed(path: string, error: string): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(error)}`);
}

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
};

/** Where to return after a bookings action. Only the bookings list itself is accepted. */
function bookingsBack(formData: FormData): string {
  const back = text(formData, "back");
  return /^\/admin\/bookings(\?[A-Za-z0-9=&%_.-]*)?$/.test(back) ? back : "/admin/bookings";
}

// ── Staff ────────────────────────────────────────────────────────────────────

export async function addStaffAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/staff");
  const result = await addStaff(await getDb(), text(formData, "email"), text(formData, "name"));
  if (!result.ok) failed("/admin/staff", result.message);
  done("/admin/staff", "Staff member added. They sign in with their email address.");
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
  await requireOwner("/admin/hours");
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
  await requireOwner("/admin/hours");
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
  await requireOwner("/admin/bookings");
  const refundCents = dollarsToCents(text(formData, "refund") || "0");
  if (refundCents === null) failed(back, "Enter the refund as an amount, for example 88 or 88.50.");
  const result = await ownerCancelBooking(await getDb(), text(formData, "ref"), { refundCents }, await manageDeps());
  flushEmailsSoon();
  if (!result.ok) failed(back, result.message);
  done(back, `Booking cancelled. ${refundNote(result.refund, result.refundCents)}`);
}

export async function ownerRefundAction(formData: FormData): Promise<void> {
  const back = bookingsBack(formData);
  await requireOwner("/admin/bookings");
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
  const kind = text(formData, "kind") === "amount" ? "amount" : "percent";
  const value = kind === "amount" ? dollarsToCents(text(formData, "value")) : intInRange(text(formData, "value"), 1, 100);
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
  await requireOwner("/admin/codes");
  await voidCode(await getDb(), text(formData, "codeId"), new Date());
  done("/admin/codes", "Code cancelled. It can no longer be used.");
}

// ── Settings ─────────────────────────────────────────────────────────────────

const NUMBER_SETTINGS = [
  "slotIncrementMinutes",
  "minLeadHours",
  "maxAdvanceDays",
  "holdMinutes",
  "refundWindowHours",
  "refundFeePercent",
  "rescheduleCutoffHours",
  "maxReschedules",
  "creditValidDays",
  "loyaltyPercent",
  "loyaltyValidDays",
  "loyaltyDelayHours",
] as const;
const SWITCH_SETTINGS = ["loyaltyEnabled", "staffSeesContact"] as const;

export async function saveSettingsAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/settings");
  const db = await getDb();
  const rejected: string[] = [];
  for (const key of NUMBER_SETTINGS) {
    const value = intInRange(text(formData, key), 0, 100000);
    if (value === null || !(await saveSetting(db, key, value))) rejected.push(key);
  }
  for (const key of SWITCH_SETTINGS) {
    if (!(await saveSetting(db, key, formData.get(key) !== null))) rejected.push(key);
  }
  updateTag(CATALOG_TAG);
  if (rejected.length > 0) {
    failed("/admin/settings", `Not saved, value out of range: ${rejected.join(", ")}. Everything else was saved.`);
  }
  done("/admin/settings", "Settings saved.");
}

export async function saveAccessInstructionsAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/settings");
  if (!(await saveAccessInstructions(await getDb(), text(formData, "accessInstructions")))) {
    failed("/admin/settings", `Not saved: the text is longer than ${ACCESS_INSTRUCTIONS_MAX} characters.`);
  }
  updateTag(CATALOG_TAG); // the guest information page says whether this is sent
  done("/admin/settings", "Saved. New confirmation emails and every confirmed booking's page now show it.");
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
  });
  if (!saved) failed("/admin/studios", "Not saved: the tagline or the description is too long.");
  updateTag(CATALOG_TAG);
  done("/admin/studios", "Studio saved.");
}

export async function saveAddonAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/studios");
  const priceCents = dollarsToCents(text(formData, "price"));
  const maxQuantity = intInRange(text(formData, "maxQuantity"), 1, 50);
  if (priceCents === null) failed("/admin/studios", "Enter the price as an amount, for example 40 or 40.50.");
  if (maxQuantity === null) failed("/admin/studios", "The most per booking must be between 1 and 50.");
  const addonId = text(formData, "addonId") || null;
  const result = await saveAddon(await getDb(), addonId, {
    name: text(formData, "name"),
    description: text(formData, "description"),
    priceCents,
    maxQuantity,
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
