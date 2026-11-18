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
  /** "people" for an extra guest: the guests a booking can take count those (`extraGuestsAllowed`). */
  kind?: string;
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
  /** Codes default to studio rentals. */
  photographyOnly?: boolean;
}

/** Why a code that exists cannot be used on a selection. */
export type PromoMisfit = "several_studios" | "photography" | "rental";

export const PROMO_MISFIT_TEXT: Record<PromoMisfit, string> = {
  several_studios: "A free hour is for one studio. It cannot be used when several studios are booked together.",
  photography: "That code is for studio rentals. It cannot be used for a photography session.",
  rental: "That code is for photography sessions. It cannot be used for a studio rental.",
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
  /**
   * How many extra guests (add-ons of kind `people`, in all) this booking can take: `extraGuestsAllowed`. Left out,
   * only each add-on's own `maxQuantity` limits them.
   */
  extraGuestsAllowed?: number | null;
  /**
   * Membership minutes paying for the studio time (follow-up 3): what is left on the membership, and whether at
   * weekends they cover only the weekday price of the time (`memberWeekendDifference`). Never with a code, nor for a
   * photography session: the server sees to both.
   */
  membership?: { minutesLeft: number; weekendDifference: boolean } | null;
}

/** The most guests in all for studios booked together, by how many: the owners' settings (10 for two, 20 for three). */
export type GuestLimits = Record<number, number>;

/**
 * How many extra guests a booking of these studios can take. One studio: its own number (`extraGuests`). Several
 * together: every guest counts toward the limit for that many studios (the owner's answer of 2026-11-17), so the
 * extra ones are what the limit leaves above the guests the studios include, and never more than the studios'
 * own extra guests added together.
 */
export function extraGuestsAllowed(studios: { includedGuests: number; extraGuests: number }[], limits: GuestLimits): number {
  if (studios.length === 0) return 0;
  const own = studios.reduce((sum, studio) => sum + Math.max(0, studio.extraGuests), 0);
  if (studios.length === 1) return own;
  const limit = limits[studios.length];
  if (limit === undefined) return own;
  const included = studios.reduce((sum, studio) => sum + studio.includedGuests, 0);
  return Math.max(0, Math.min(own, limit - included));
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
  /** The membership minutes the booking takes: its length, or what is left when that is less. */
  membershipMinutes: number;
  /** The part of the studio price those minutes pay. */
  membershipCents: number;
  totalCents: number;
}

export type PricingErrorCode =
  | "NO_STUDIOS"
  | "DUPLICATE_STUDIO"
  | "NO_PRICE"
  | "UNKNOWN_ADDON"
  | "ADDON_NOT_ALLOWED"
  | "BAD_QUANTITY"
  | "TOO_MANY_GUESTS"
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

  const allowed = input.extraGuestsAllowed;
  if (allowed !== undefined && allowed !== null) {
    const guests = addonLines.reduce((sum, line) => sum + (catalog.find((a) => a.id === line.addonId)?.kind === "people" ? line.quantity : 0), 0);
    if (guests > allowed) {
      throw new PricingError(
        "TOO_MANY_GUESTS",
        allowed === 0 ? "No extra guests can come with this booking." : `At most ${allowed} extra ${allowed === 1 ? "guest" : "guests"} can come with this booking.`,
      );
    }
  }

  // A percent code discounts the rental or session price. An amount code
  // can pay for the entire booking, including add-ons, within its scope.
  // A free hour takes the price of one hour of one studio off: it is not for
  // several studios booked together, and it does not pay for add-ons.
  let promoDiscountCents = 0;
  let promoMisfit: PromoMisfit | null = null;
  const promo = input.promo;
  if (promo && (promo.photographyOnly === true) !== Boolean(photoPackage)) {
    promoMisfit = photoPackage ? "photography" : "rental";
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

  // Membership minutes pay for studio time, never add-ons: the booking's length, or what is left. A booking longer than
  // what is left pays the share of its studio price the minutes do not cover (the builder's reading, question 42). At
  // weekends, while the owners keep that rule, the minutes cover the weekday price of the time and the rest of the
  // weekend price is paid (question 41).
  let membershipMinutes = 0;
  let membershipCents = 0;
  const membership = input.membership;
  if (membership && !photoPackage) {
    if (!(Number.isInteger(membership.minutesLeft) && membership.minutesLeft >= 0)) throw new PricingError("BAD_PROMO", "Invalid code.");
    membershipMinutes = Math.min(membership.minutesLeft, durationMinutes);
    let basisCents = studiosNetCents;
    if (membership.weekendDifference && dayType === "weekend") {
      const weekday = studioLines.map((line) => findPrice(line.studioId, "weekday", durationMinutes, rules));
      if (weekday.every((cents) => cents !== null)) {
        const subtotal = weekday.reduce((sum: number, cents) => sum + cents!, 0);
        basisCents = subtotal - percentOf(subtotal, multiStudioPercent);
      }
    }
    membershipCents = Math.min(studiosNetCents - promoDiscountCents, Math.round((basisCents * membershipMinutes) / durationMinutes));
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
    membershipMinutes,
    membershipCents,
    totalCents: studiosNetCents + addonsCents - promoDiscountCents - membershipCents,
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
