/**
 * Price calculation. Pure functions, amounts in integer cents.
 *
 * The same code runs in the browser (instant preview) and on the server
 * (the only result that is ever charged).
 */
import type { DayType } from "./time";

export interface PriceRule {
  studioId: string;
  dayType: DayType;
  durationMinutes: number;
  priceCents: number;
}

export interface AddonDef {
  id: string;
  name: string;
  priceCents: number;
  /** null = can be added to any booking; otherwise only when that studio is booked. */
  studioId: string | null;
  maxQuantity: number;
}

export interface AddonSelection {
  addonId: string;
  quantity: number;
}

export type PromoKind = "percent" | "amount" | "free_hour";

export interface PromoDef {
  kind: PromoKind;
  /** percent: 1-100. amount: cents available to spend. free_hour: the minutes that are free (60). */
  value: number;
}

/** Why a code that exists cannot be used on a selection. */
export type PromoMisfit = "several_studios" | "photography";

export const PROMO_MISFIT_TEXT: Record<PromoMisfit, string> = {
  several_studios: "A free hour is for one studio. It cannot be used when several studios are booked together.",
  photography: "That code is for studio rentals. It cannot be used for a photography session.",
};

export interface QuoteInput {
  studioIds: string[];
  dayType: DayType;
  durationMinutes: number;
  rules: PriceRule[];
  /** Discount percent by number of studios booked together, e.g. { 2: 20, 3: 22 }. */
  multiStudioPercent: Record<number, number>;
  addons?: AddonSelection[];
  addonCatalog?: AddonDef[];
  promo?: PromoDef | null;
  /**
   * Set for a photography session: the package's price, which includes the
   * studio. The booking is then for exactly one studio, and that studio's own
   * price list is not consulted.
   */
  photoPackage?: { priceCents: number } | null;
}

export interface Quote {
  studioLines: { studioId: string; priceCents: number }[];
  studiosSubtotalCents: number;
  multiStudioPercent: number;
  multiStudioDiscountCents: number;
  addonLines: { addonId: string; name: string; quantity: number; unitCents: number; totalCents: number }[];
  addonsCents: number;
  promoDiscountCents: number;
  /**
   * Set when a code was given that cannot be used on this selection. The
   * price is then the price without the code, and the customer is told why.
   */
  promoMisfit: PromoMisfit | null;
  totalCents: number;
}

export type PricingErrorCode =
  | "NO_STUDIOS"
  | "DUPLICATE_STUDIO"
  | "NO_PRICE"
  | "UNKNOWN_ADDON"
  | "ADDON_NOT_ALLOWED"
  | "BAD_QUANTITY"
  | "BAD_PROMO"
  | "BAD_PACKAGE";

export class PricingError extends Error {
  constructor(
    public code: PricingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PricingError";
  }
}

function percentOf(cents: number, percent: number): number {
  return Math.round((cents * percent) / 100);
}

/** The discount for N studios is the rule with the largest count that is <= N. */
export function multiStudioPercentFor(count: number, table: Record<number, number>): number {
  let best = 0;
  let bestCount = 0;
  for (const [key, value] of Object.entries(table)) {
    const n = Number(key);
    if (!Number.isInteger(n) || n < 2) continue;
    if (n <= count && n > bestCount) {
      bestCount = n;
      best = value;
    }
  }
  if (!(best >= 0 && best <= 100)) return 0;
  return best;
}

/** Durations that have a price for every selected studio on that day type. */
export function bookableDurations(studioIds: string[], dayType: DayType, rules: PriceRule[]): number[] {
  if (studioIds.length === 0) return [];
  const perStudio = studioIds.map(
    (id) =>
      new Set(
        rules.filter((r) => r.studioId === id && r.dayType === dayType).map((r) => r.durationMinutes),
      ),
  );
  const [first, ...rest] = perStudio;
  return [...first].filter((d) => rest.every((s) => s.has(d))).sort((a, b) => a - b);
}

export function findPrice(
  studioId: string,
  dayType: DayType,
  durationMinutes: number,
  rules: PriceRule[],
): number | null {
  const rule = rules.find(
    (r) => r.studioId === studioId && r.dayType === dayType && r.durationMinutes === durationMinutes,
  );
  return rule ? rule.priceCents : null;
}

export function quote(input: QuoteInput): Quote {
  const { studioIds, dayType, durationMinutes, rules } = input;
  if (studioIds.length === 0) throw new PricingError("NO_STUDIOS", "Select at least one studio.");
  if (new Set(studioIds).size !== studioIds.length) {
    throw new PricingError("DUPLICATE_STUDIO", "A studio was selected twice.");
  }

  const photoPackage = input.photoPackage ?? null;
  if (photoPackage) {
    if (studioIds.length !== 1) throw new PricingError("BAD_PACKAGE", "A photography session is in one studio.");
    if (!(Number.isInteger(photoPackage.priceCents) && photoPackage.priceCents >= 0)) {
      throw new PricingError("BAD_PACKAGE", "That photography session is not offered.");
    }
  }
  const studioLines = studioIds.map((studioId) => {
    // A session's price includes the studio, so the studio's own price list is not consulted.
    const priceCents = photoPackage ? photoPackage.priceCents : findPrice(studioId, dayType, durationMinutes, rules);
    if (priceCents === null) {
      throw new PricingError("NO_PRICE", "That duration is not offered for the selected studios.");
    }
    return { studioId, priceCents };
  });
  const studiosSubtotalCents = studioLines.reduce((sum, l) => sum + l.priceCents, 0);

  const multiStudioPercent = multiStudioPercentFor(studioIds.length, input.multiStudioPercent);
  const multiStudioDiscountCents = percentOf(studiosSubtotalCents, multiStudioPercent);
  const studiosNetCents = studiosSubtotalCents - multiStudioDiscountCents;

  const catalog = input.addonCatalog ?? [];
  const seen = new Set<string>();
  const addonLines = (input.addons ?? [])
    .filter((sel) => sel.quantity !== 0)
    .map((sel) => {
      const def = catalog.find((a) => a.id === sel.addonId);
      if (!def) throw new PricingError("UNKNOWN_ADDON", "An add-on you chose is no longer offered.");
      if (seen.has(def.id)) throw new PricingError("BAD_QUANTITY", "An add-on was listed twice.");
      seen.add(def.id);
      if (def.studioId !== null && !studioIds.includes(def.studioId)) {
        throw new PricingError("ADDON_NOT_ALLOWED", `${def.name} is not available for the selected studios.`);
      }
      if (!Number.isInteger(sel.quantity) || sel.quantity < 1 || sel.quantity > def.maxQuantity) {
        throw new PricingError("BAD_QUANTITY", `Invalid quantity for ${def.name}.`);
      }
      return {
        addonId: def.id,
        name: def.name,
        quantity: sel.quantity,
        unitCents: def.priceCents,
        totalCents: def.priceCents * sel.quantity,
      };
    });
  const addonsCents = addonLines.reduce((sum, l) => sum + l.totalCents, 0);

  // A percent code discounts the studio rental only. An amount code is money
  // already owed to the customer, so it can pay for anything on the booking.
  // A free hour takes the price of one hour of one studio off: it is not for
  // several studios booked together, and it does not pay for add-ons.
  let promoDiscountCents = 0;
  let promoMisfit: PromoMisfit | null = null;
  const promo = input.promo;
  if (promo && photoPackage && promo.kind !== "amount") {
    // Discount codes and free hours are for renting a studio. Money already paid (a reschedule credit) pays for anything.
    promoMisfit = "photography";
  } else if (promo) {
    if (promo.kind === "percent") {
      if (!(promo.value > 0 && promo.value <= 100)) throw new PricingError("BAD_PROMO", "Invalid code.");
      promoDiscountCents = percentOf(studiosNetCents, promo.value);
    } else if (promo.kind === "amount") {
      if (!(Number.isInteger(promo.value) && promo.value > 0)) throw new PricingError("BAD_PROMO", "Invalid code.");
      promoDiscountCents = Math.min(promo.value, studiosNetCents + addonsCents);
    } else {
      if (!(Number.isInteger(promo.value) && promo.value > 0)) throw new PricingError("BAD_PROMO", "Invalid code.");
      if (studioLines.length !== 1) {
        promoMisfit = "several_studios";
      } else {
        const [line] = studioLines;
        // The studio's own price for that long on this kind of day. When it is
        // not sold for exactly that long, the same share of this booking's price.
        const listed = findPrice(line.studioId, dayType, promo.value, rules);
        const worth = listed ?? Math.round((line.priceCents * promo.value) / durationMinutes);
        promoDiscountCents = Math.min(worth, line.priceCents);
      }
    }
  }

  return {
    studioLines,
    studiosSubtotalCents,
    multiStudioPercent,
    multiStudioDiscountCents,
    addonLines,
    addonsCents,
    promoDiscountCents,
    promoMisfit,
    totalCents: studiosNetCents + addonsCents - promoDiscountCents,
  };
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = abs % 100;
  const whole = dollars.toLocaleString("en-US");
  return rest === 0 ? `${sign}$${whole}` : `${sign}$${whole}.${String(rest).padStart(2, "0")}`;
}
