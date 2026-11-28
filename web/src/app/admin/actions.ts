"use server";

import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { isAddonKind } from "@/lib/addon-kinds";
import { count } from "@/lib/words";
import { createBlocks, removeBlocks, updateBlocks, type BlockPlan } from "@/server/blocked-time";
import { studioCombinationError } from "@/lib/catalog-view";
import { loadCatalog } from "@/server/catalog";
import { dollarsToCents, formText, hhmmToMinutes, intInRange } from "@/lib/parse";
import { ADMIN_LEVELS, ATTENDANT_SWITCH_KEYS, isAdminLevel, MANAGER_SWITCH_KEYS } from "@/lib/abilities";
import { formatCents, TAX_BASIS_POINTS_MAX, taxPercent } from "@/lib/domain/pricing";
import { durationLabel, isIsoDate } from "@/lib/domain/time";
import {
  addStaff,
  createManualCode,
  PRICE_MAX_CENTS,
  removeStaff,
  saveAddon,
  saveBundlePrice,
  savePrice,
  saveStudioDetails,
  setStudioActive,
  STUDIO_NAME_MAX,
  saveStudioHours,
  setAddonActive,
  setShift,
  setSpecialDate,
  setStaffLevel,
  voidCode,
} from "@/server/admin";
import { CATALOG_TAG } from "@/server/cached";
import { deleteSale, endSale, saveSale } from "@/server/sales";
import { localDateOf } from "@/server/tz";
import { FREE_HOUR_MINUTES } from "@/server/loyalty";
import { ownerCancelBooking, ownerRefund, recordRefundMadeInSquare, type RefundsState } from "@/server/manage";
import { resolvePayments } from "@/server/payments";
import { flushEmailsSoon, manageDeps } from "@/server/runtime";
import { notFound } from "next/navigation";
import { can, type Ability } from "@/lib/abilities";
import { requireManager, requireOwner } from "@/server/session";
import {
  ACCESS_INSTRUCTIONS_MAX,
  BETWEEN_LENGTHS, LONGEST_BOOKINGS, SHOWN_LENGTHS_MAX,
  loadSettings,
  MONEY_SETTING_RANGES,
  NUMBER_SETTING_RANGES,
  saveAccessInstructions,
  saveContactInbox,
  saveSetting,
  switchLoyalty,
  type MoneySettingKey,
  type NumberSettingKey,
} from "@/server/settings";
import { settingLabel } from "./settings/fields";
import { addStudioPhotos, moveStudioPhoto, removeStudioPhoto, setStudioFloorPlan } from "@/server/studio-photos";
import { includedList, sectionList } from "@/lib/studio-facts";

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

/**
 * Where to return after a bookings action: the bookings list, or an appointment's page, whose payment card refunds
 * what a booking was paid beyond its price (follow-up 5). Nothing else is followed.
 */
function bookingsBack(formData: FormData): string {
  const back = text(formData, "back");
  return /^\/admin\/bookings(\?[A-Za-z0-9=&%_.-]*)?$/.test(back) || /^\/admin\/appointments\/VS-[0-9A-Z]{6}$/.test(back) ? back : "/admin/bookings";
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
  // Checked whole before anything is saved, and saved together: a form is never half saved.
  for (const change of changes) {
    if (change.priceCents !== null && change.priceCents > PRICE_MAX_CENTS) {
      failed(
        "/admin/prices",
        `Not saved: the price for ${durationLabel(change.durationMinutes)} ${change.dayType === "weekday" ? "Mon–Fri" : "Sat–Sun"} is more than ${formatCents(PRICE_MAX_CENTS)}, the most a price can be. Nothing was changed.`,
      );
    }
  }
  let saved = true;
  try {
    await db.transaction(async (tx) => {
      for (const change of changes) if (!(await savePrice(tx, { studioId, ...change }))) throw new Error("A price was refused.");
    });
  } catch {
    saved = false;
  }
  if (!saved) failed("/admin/prices", "The prices could not be saved, and none was changed. Check that each is an amount in dollars.");
  updateTag(CATALOG_TAG);
  done("/admin/prices", "Prices saved.");
}

export async function addDurationAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/prices");
  const minutes = intInRange(text(formData, "minutes"), 15, 1440);
  if (minutes === null || minutes % 15 !== 0) failed("/admin/prices", "Enter the duration in minutes, from 15 to 1440, in steps of 15: 90 is an hour and a half.");
  const weekday = dollarsToCents(text(formData, "weekday"));
  const weekendRaw = text(formData, "weekend");
  const weekend = weekendRaw === "" ? weekday : dollarsToCents(weekendRaw);
  if (weekday === null || weekend === null) failed("/admin/prices", "Enter each price as an amount in dollars, for example 88 or 88.50.");
  if (weekday > PRICE_MAX_CENTS || weekend > PRICE_MAX_CENTS) failed("/admin/prices", `A price can be at most ${formatCents(PRICE_MAX_CENTS)}.`);
  const db = await getDb();
  const studioId = text(formData, "studioId");
  let added = true;
  try {
    await db.transaction(async (tx) => {
      const a = await savePrice(tx, { studioId, dayType: "weekday", durationMinutes: minutes, priceCents: weekday });
      const b = await savePrice(tx, { studioId, dayType: "weekend", durationMinutes: minutes, priceCents: weekend });
      if (!a || !b) throw new Error("A price was refused.");
    });
  } catch {
    added = false;
  }
  if (!added) failed("/admin/prices", "That duration could not be added: the studio was not found.");
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

/** The studios a bundle's form is for: the ids it carries, when those studios may be booked together. */
async function bundleOfForm(formData: FormData): Promise<string[]> {
  const studioIds = text(formData, "studioIds").split(",").filter(Boolean);
  const catalog = await loadCatalog(await getDb());
  if (studioIds.length < 2 || !studioIds.every((id) => catalog.studios.some((studio) => studio.id === id)) || studioCombinationError(catalog.studios, studioIds)) {
    failed("/admin/prices", "Those studios cannot be booked together.");
  }
  return studioIds;
}

/** A bundle's prices, one for each length of its list; a price cleared takes that length off the list. */
export async function saveBundlePricesAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/prices");
  const studioIds = await bundleOfForm(formData);
  const changes: { durationMinutes: number; priceCents: number | null }[] = [];
  for (const [name, value] of formData.entries()) {
    const match = /^price:(\d+)$/.exec(name);
    if (!match || typeof value !== "string") continue;
    const priceCents = value.trim() === "" ? null : dollarsToCents(value);
    if (value.trim() !== "" && priceCents === null) failed("/admin/prices", `"${value}" is not a valid price.`);
    if (priceCents !== null && priceCents > PRICE_MAX_CENTS) {
      failed("/admin/prices", `Not saved: the price for ${durationLabel(Number(match[1]))} is more than ${formatCents(PRICE_MAX_CENTS)}, the most a price can be. Nothing was changed.`);
    }
    changes.push({ durationMinutes: Number(match[1]), priceCents });
  }
  const db = await getDb();
  let saved = true;
  try {
    await db.transaction(async (tx) => {
      for (const change of changes) if (!(await saveBundlePrice(tx, { studioIds, ...change }))) throw new Error("A price was refused.");
    });
  } catch {
    saved = false;
  }
  if (!saved) failed("/admin/prices", "The prices could not be saved, and none was changed. Check that each is an amount in dollars.");
  updateTag(CATALOG_TAG);
  done("/admin/prices", "Bundle prices saved.");
}

export async function addBundleLengthAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/prices");
  const studioIds = await bundleOfForm(formData);
  const minutes = intInRange(text(formData, "minutes"), 15, 1440);
  if (minutes === null || minutes % 15 !== 0) failed("/admin/prices", "Enter the duration in minutes, from 15 to 1440, in steps of 15: 90 is an hour and a half.");
  const price = dollarsToCents(text(formData, "price"));
  if (price === null) failed("/admin/prices", "Enter the price as an amount in dollars, for example 230 or 172.50.");
  if (price > PRICE_MAX_CENTS) failed("/admin/prices", `A price can be at most ${formatCents(PRICE_MAX_CENTS)}.`);
  if (!(await saveBundlePrice(await getDb(), { studioIds, durationMinutes: minutes, priceCents: price }))) failed("/admin/prices", "That duration could not be added.");
  updateTag(CATALOG_TAG);
  done("/admin/prices", "Duration added.");
}

/**
 * The lengths that can be booked besides the listed ones (between them, every half hour, every hour or none, and up to
 * how long), and those the booking screen shows before "More".
 */
export async function saveLengthsAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/prices");
  const step = Number(text(formData, "betweenLengthsMinutes"));
  const longest = Number(text(formData, "longestBookingMinutes"));
  if (!BETWEEN_LENGTHS.includes(step) || !LONGEST_BOOKINGS.includes(longest)) failed("/admin/prices", "Choose from the lists.");
  const words = text(formData, "shownLengths").split(/[\s,]+/).filter(Boolean);
  const shown = [...new Set(words.map((hours) => (/^\d+(\.\d+)?$/.test(hours) ? Math.round(Number(hours) * 60) : NaN)))].sort((a, b) => a - b);
  const db = await getDb();
  if (!(await saveSetting(db, "shownLengthsMinutes", shown))) {
    failed("/admin/prices", `Enter the lengths shown first in hours, separated by commas, at most ${SHOWN_LENGTHS_MAX}: for example 1, 2, 3, 4, 6 (1.5 is an hour and a half).`);
  }
  if (!(await saveSetting(db, "betweenLengthsMinutes", step)) || !(await saveSetting(db, "longestBookingMinutes", longest))) failed("/admin/prices", "Choose from the lists.");
  updateTag(CATALOG_TAG);
  done("/admin/prices", step === 0 ? "Only the listed lengths can be booked now." : "The lengths that can be booked are saved.");
}

/**
 * The sales tax added on top of the prices: its rate, typed as a percentage, and what it applies to. Bookings already
 * made keep the rate they were made at.
 */
export async function saveSalesTaxAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/prices");
  const typed = text(formData, "salesTaxPercent");
  const basisPoints = /^\d{1,2}(\.\d{1,2})?$/.test(typed) ? Math.round(Number(typed) * 100) : NaN;
  const db = await getDb();
  if (!(await saveSetting(db, "salesTaxBasisPoints", basisPoints))) {
    failed("/admin/prices", `Enter the sales tax as a percentage from 0 to ${TAX_BASIS_POINTS_MAX / 100}, with at most two decimals: for example 6.5. 0 charges none.`);
  }
  for (const key of ["taxStudioTime", "taxSessions", "taxAddons"] as const) await saveSetting(db, key, formData.get(key) === "on");
  updateTag(CATALOG_TAG);
  done("/admin/prices", basisPoints === 0 ? "No sales tax is added now." : `Sales tax saved: ${taxPercent(basisPoints)}, for bookings made from now on.`);
}

/** Add a sale, or change one (Admin → Prices, "Sales"; src/server/sales.ts). */
export async function saveSaleAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/prices");
  const id = text(formData, "id") || null;
  const result = await saveSale(await getDb(), id, {
    name: text(formData, "name"),
    percent: text(formData, "percent"),
    studioIds: formData.getAll("studio").map(String),
    bookFrom: text(formData, "bookFrom"),
    bookUntil: text(formData, "bookUntil"),
    visitFrom: text(formData, "visitFrom"),
    visitUntil: text(formData, "visitUntil"),
    withCodes: formData.get("withCodes") !== null,
  });
  if (!result.ok) failed(id ? `/admin/prices?sale=${id}` : "/admin/prices", result.message);
  updateTag(CATALOG_TAG); // the price lists and the booking screen show a sale
  done("/admin/prices", id ? "Sale saved." : "Sale added. It begins and ends by itself, on its days.");
}

/** End a sale now, or delete one. The bookings made under it keep their prices. */
export async function saleAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/prices");
  const db = await getDb();
  const id = text(formData, "id");
  const intent = text(formData, "intent");
  const found = intent === "end" ? await endSale(db, id, localDateOf(new Date())) : intent === "delete" ? await deleteSale(db, id) : false;
  if (!found) failed("/admin/prices", "That sale is gone.");
  updateTag(CATALOG_TAG);
  done("/admin/prices", intent === "end" ? "The sale has ended. The bookings made under it keep their prices." : "Sale deleted. The bookings made under it keep their prices.");
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

/** A plan of blocked time from the form of Availability & Blocked Time (src/server/blocked-time.ts). */
async function blockPlanFrom(formData: FormData): Promise<BlockPlan> {
  // "Select All Studios": every studio offered, whichever boxes are ticked.
  const all = formData.get("allStudios") === "1";
  const studioIds = all
    ? (await loadCatalog(await getDb())).studios.map((studio) => studio.id)
    : formData.getAll("studio").filter((value): value is string => typeof value === "string");
  const wholeDay = formData.get("wholeDay") === "1";
  return {
    studioIds,
    from: text(formData, "from"),
    to: text(formData, "to"),
    wholeDay,
    startMinute: wholeDay ? 0 : (hhmmToMinutes(text(formData, "start")) ?? -1),
    endMinute: wholeDay ? 0 : (hhmmToMinutes(text(formData, "end")) ?? -1),
    weekdays: formData.getAll("weekday").map((value) => Number(value)),
    reason: text(formData, "reason"),
    note: text(formData, "note"),
  };
}

const availabilityBack = (month: string) => `/admin/availability${/^\d{4}-\d{2}$/.test(month) ? `?month=${month}` : ""}`;

export async function createBlocksAction(formData: FormData): Promise<void> {
  await requireAbility("blockTime", "/admin/availability");
  const plan = await blockPlanFrom(formData);
  const back = availabilityBack(plan.from.slice(0, 7));
  const result = await createBlocks(await getDb(), plan, new Date());
  if (!result.ok) failed(back, result.message);
  done(back, `Blocked: ${count(result.days, "day")}. Clients can no longer book that time.`);
}

export async function updateBlocksAction(formData: FormData): Promise<void> {
  await requireAbility("blockTime", "/admin/availability");
  const plan = await blockPlanFrom(formData);
  const key = text(formData, "key");
  const back = availabilityBack(plan.from.slice(0, 7));
  const result = await updateBlocks(await getDb(), key, plan, new Date());
  if (!result.ok) failed(`${back}${back.includes("?") ? "&" : "?"}edit=${encodeURIComponent(key)}`, result.message);
  done(back, `Changed: ${count(result.days, "day")} blocked.`);
}

export async function removeBlocksAction(formData: FormData): Promise<void> {
  await requireAbility("blockTime", "/admin/availability");
  const removed = await removeBlocks(await getDb(), text(formData, "key"));
  done(availabilityBack(text(formData, "month")), removed > 0 ? `Removed: ${count(removed, "day")} no longer blocked.` : "That block was already removed.");
}

// ── Bookings ─────────────────────────────────────────────────────────────────

const refundNote = (refund: RefundsState, cents: number) =>
  refund === "none"
    ? "No refund."
    : refund === "sent"
      ? `${formatCents(cents)} refunded to the card.`
      : refund === "waiting"
        ? `${formatCents(cents)} refund recorded, not sent: ${resolvePayments().provider ? "the card processor set up now cannot send it" : "no card processor is set up now"}, so it waits, listed on the overview with the reason.`
        : `${formatCents(cents)} refund recorded; it has not gone through yet and will be retried.`;

export async function ownerCancelAction(formData: FormData): Promise<void> {
  const back = bookingsBack(formData);
  await requireAbility("refund", "/admin/bookings");
  const refundCents = dollarsToCents(text(formData, "refund") || "0");
  if (refundCents === null) failed(back, "Enter the refund as an amount, for example 88 or 88.50.");
  const seen = Number(text(formData, "seenCard"));
  const result = await ownerCancelBooking(
    await getDb(),
    text(formData, "ref"),
    { refundCents, ...(Number.isInteger(seen) && text(formData, "seenCard") !== "" ? { seenCardCents: seen } : {}) },
    await manageDeps(),
  );
  flushEmailsSoon();
  if (!result.ok) failed(back, result.message);
  const atStudio = result.atStudioCents
    ? ` ${formatCents(result.atStudioCents)} of what was paid ${result.handPaidPlace ?? "at the studio"} can be given back: give back what is owed by hand, then record it on the appointment's page.`
    : "";
  done(back, `Booking cancelled. ${refundNote(result.refund, result.refundCents)}${atStudio}`);
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
    {
      kind,
      value,
      email: text(formData, "email") || null,
      validDays,
      maxUses,
      note: text(formData, "note"),
      photographyOnly: chosen === "photo_percent",
      code: text(formData, "code"),
      bookingDays: {
        from: isIsoDate(text(formData, "daysFrom")) ? text(formData, "daysFrom") : null,
        until: isIsoDate(text(formData, "daysUntil")) ? text(formData, "daysUntil") : null,
        weekdays: [...new Set(formData.getAll("weekday").map((value) => Number(value)))].filter((day) => Number.isInteger(day) && day >= 1 && day <= 7),
        notOnSpecialDates: formData.get("notOnSpecialDates") === "1",
      },
    },
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
const MONEY_SETTINGS = Object.keys(MONEY_SETTING_RANGES) as MoneySettingKey[];
// What staff can do is set on the Staff page (saveStaffAbilitiesAction), not here.

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
  for (const key of MONEY_SETTINGS) {
    const cents = dollarsToCents(text(formData, key));
    if (cents === null || !(await saveSetting(db, key, cents))) {
      const [min, max] = MONEY_SETTING_RANGES[key];
      rejected.push(`${settingLabel(key)} is an amount from ${formatCents(min)} to ${formatCents(max)}`);
    }
  }
  // Loyalty has a switch of its own: switching it on after it was off starts the stamps over (`switchLoyalty`).
  await switchLoyalty(db, formData.get("loyaltyEnabled") !== null, new Date());
  await saveSetting(db, "memberWeekendDifference", formData.get("memberWeekendDifference") !== null);
  await saveSetting(db, "lateCancelKeepsCode", formData.get("lateCancelKeepsCode") !== null);
  await saveSetting(db, "weekdayCodeOnWeekdays", formData.get("weekdayCodeOnWeekdays") !== null);
  updateTag(CATALOG_TAG);
  if (rejected.length > 0) {
    failed("/admin/settings", `Not saved: ${rejected.join("; ")}. Everything else was saved.`);
  }
  done("/admin/settings", "Settings saved.");
}

export async function saveContactInboxAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/settings");
  const inbox = text(formData, "contactInbox");
  if (!(await saveContactInbox(await getDb(), inbox))) failed("/admin/settings", "Not saved: that is not an email address.");
  done(
    "/admin/settings",
    inbox.trim() === "" ? "Saved. Messages from the contact form go where the site's notices go." : `Saved. Messages from the contact form now go to ${inbox.trim().toLowerCase()}.`,
  );
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
  const extraGuests = intInRange(text(formData, "extraGuests"), 0, 100);
  const bufferMinutes = intInRange(text(formData, "bufferMinutes"), 0, 240);
  if (includedGuests === null || extraGuests === null || bufferMinutes === null) {
    failed("/admin/studios", "Not saved: guests included must be 1 to 100, extra guests 0 to 100, and clean-up time 0 to 240 minutes.");
  }
  const saved = await saveStudioDetails(await getDb(), text(formData, "studioId"), {
    name: text(formData, "name"),
    tagline: text(formData, "tagline"),
    description: text(formData, "description"),
    includedGuests,
    extraGuests,
    bufferMinutes,
    facts: {
      size: text(formData, "size"),
      ceiling: text(formData, "ceiling"),
      light: text(formData, "light"),
      cyclorama: text(formData, "cyclorama"),
      included: includedList(formText(formData.get("included"))),
      // The sections' titles and texts, row by row (the studios page's form keeps them in pairs).
      sections: sectionList(formData.getAll("sectionTitle").map((title, index) => ({ title: formText(title), text: formText(formData.getAll("sectionText")[index] ?? "") }))),
    },
  });
  if (!saved) {
    failed(
      "/admin/studios",
      `Not saved: the name must be 1 to ${STUDIO_NAME_MAX} characters and not another studio's, and the tagline and the description not too long.`,
    );
  }
  updateTag(CATALOG_TAG);
  done("/admin/studios", "Studio saved.");
}

/** Take a studio off the site, or put it back (question 29). */
export async function setStudioActiveAction(formData: FormData): Promise<void> {
  await requireOwner("/admin/studios");
  const active = text(formData, "active") === "true";
  const result = await setStudioActive(await getDb(), text(formData, "studioId"), active, new Date());
  if (!result.ok) {
    failed(
      "/admin/studios",
      result.code === "booked"
        ? `Not taken off: ${count(result.bookings, "booking")} still to come ${result.bookings === 1 ? "holds" : "hold"} it. Move or cancel ${result.bookings === 1 ? "it" : "them"} first (Bookings).`
        : "That studio could not be found.",
    );
  }
  updateTag(CATALOG_TAG);
  done(
    "/admin/studios",
    active ? "Studio put back on the site. Customers can book it again." : "Studio taken off the site. Its past bookings and receipts keep it, and it can be put back here.",
  );
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
  if (priceCents > PRICE_MAX_CENTS) failed("/admin/studios", `A price can be at most ${formatCents(PRICE_MAX_CENTS)}.`);
  if (!isAddonKind(kind)) failed("/admin/studios", "Choose what the add-on is for.");
  const addonId = text(formData, "addonId") || null;
  const result = await saveAddon(await getDb(), addonId, {
    name: text(formData, "name"),
    description: text(formData, "description"),
    priceCents,
    kind,
    studioId: text(formData, "studioId") || null,
    // A prop (the owner's admin brief of 2026-11-22, item 10): how many there are. Empty is no limit.
    stock: text(formData, "stock") === "" ? null : Number(text(formData, "stock")),
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
