/**
 * Price calculation. Pure functions, amounts in integer cents.
 *
 * The same code runs in the browser (instant preview) and on the server
 * (the only result that is ever charged).
 */
import { promoDayMisfitText, promoFitsDay, type PromoDays } from "./promo-days";
import type { DayType, IsoDate } from "./time";

export interface PriceRule {
  studioId: string;
  dayType: DayType;
  durationMinutes: number;
  priceCents: number;
  /** Worked out between two listed lengths (`withBetween`), not typed in by the owners: the price lists leave it out. */
  between?: true;
}

/**
 * The owners' price for studios booked together, for one length: the same on every day (the owner's answers of
 * 2026-11-25, question 81 in ProjectLibrary.md). The studios that have such prices are a bundle with a price list of
 * its own, and a booking of exactly those studios costs what the list says, whatever each studio costs alone.
 */
export interface BundlePrice {
  studioIds: string[];
  durationMinutes: number;
  priceCents: number;
  /** As a rule's. */
  between?: true;
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
  /** The days a booking with it may be on (promo-days.ts); none, any day. */
  days?: PromoDays | null;
}

/** Why a code that exists cannot be used on a selection. */
export type PromoMisfit = "several_studios" | "photography" | "content" | "rental" | "day";

/**
 * A code for sessions (`photographyOnly`) is for both kinds, photography and content creation: a session moved for a
 * code gets one, whatever its kind (question 69 in ProjectLibrary.md).
 */
export const PROMO_MISFIT_TEXT: Record<PromoMisfit, string> = {
  several_studios: "A free hour is for one studio. It cannot be used when several studios are booked together.",
  photography: "That code is for studio rentals. It cannot be used for a photography session.",
  content: "That code is for studio rentals. It cannot be used for a content creation session.",
  rental: "That code is for photography and content creation sessions. It cannot be used for a studio rental.",
  day: "That code cannot be used for a booking on that day.",
};

/**
 * Why a code does not fit. For its days, the days it works for and why the booking's day is not one of them
 * (`promoDayMisfitText`); `bookingDay` is the booking's, as given to `quote`.
 */
export function promoMisfitText(misfit: PromoMisfit, promo: PromoDef | null | undefined, bookingDay?: { date: IsoDate; special: boolean } | null): string {
  return misfit === "day" ? promoDayMisfitText(promo?.days, bookingDay?.date ?? null, bookingDay?.special ?? false) : PROMO_MISFIT_TEXT[misfit];
}

export interface QuoteInput {
  studioIds: string[];
  dayType: DayType;
  durationMinutes: number;
  rules: PriceRule[];
  /** The prices of studios booked together. Studios that have none together pay their own prices, less the discount below. */
  bundlePrices: BundlePrice[];
  /** Discount percent by number of studios booked together, e.g. { 2: 20, 3: 22 }: for studios without prices together. */
  multiStudioPercent: Record<number, number>;
  addons?: AddonSelection[];
  addonCatalog?: AddonDef[];
  promo?: PromoDef | null;
  /** The booking's day, which a code's days are checked against; and whether it is under Holidays and special dates. Left out: not checked. */
  bookingDay?: { date: IsoDate; special: boolean } | null;
  /**
   * Set for a photography session: the package's price, which includes the
   * studio. The booking is then for exactly one studio, and that studio's own
   * price list is not consulted.
   */
  photoPackage?: { priceCents: number; service?: "photography" | "content" } | null;
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
  /**
   * Each studio's price. For studios with a price together (`BundlePrice`), each one's share of it (`shareOf`), which
   * no summary shows: they show the studios on one line (`studioPriceLines`).
   */
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

/** How the table of bundle prices names studios booked together: their ids, sorted, joined by "+". */
export function bundleKey(studioIds: readonly string[]): string {
  return [...studioIds].sort().join("+");
}

/** The price list of exactly these studios booked together. Empty for one studio, and for studios the owners gave none. */
export function bundleList(studioIds: readonly string[], bundlePrices: readonly BundlePrice[]): BundlePrice[] {
  if (studioIds.length < 2) return [];
  return bundlePrices.filter((price) => price.studioIds.length === studioIds.length && price.studioIds.every((id) => studioIds.includes(id)));
}

/**
 * A total shared by weights, in whole cents that add up to it: the first takes what rounding leaves. Evenly when a
 * weight is missing. It gives each studio of a bundle its part of the bundle's price.
 */
export function shareOf(total: number, weights: readonly (number | null)[]): number[] {
  const usable = weights.every((weight) => weight !== null && weight > 0);
  const base = usable ? (weights as number[]) : weights.map(() => 1);
  const sum = base.reduce((all, weight) => all + weight, 0);
  const shares = base.map((weight) => Math.floor((total * weight) / sum));
  shares[0] += total - shares.reduce((all, share) => all + share, 0);
  return shares;
}

/**
 * The lines a summary shows for a booking's studios. Studios booked together at one price (nothing taken off for
 * booking several) are one line, "Studio Paris + Studio Dayglow": each one's part of that price is bookkeeping, not a
 * price anyone was quoted. With a discount for several studios, each studio's own price, and the discount follows.
 */
export function studioPriceLines(studios: readonly { name: string; priceCents: number }[], multiStudioDiscountCents: number): { name: string; priceCents: number }[] {
  if (studios.length < 2 || multiStudioDiscountCents > 0) return studios.map(({ name, priceCents }) => ({ name, priceCents }));
  return [{ name: studios.map((studio) => studio.name).join(" + "), priceCents: studios.reduce((sum, studio) => sum + studio.priceCents, 0) }];
}

/**
 * The lengths between the listed ones, each priced on the straight line between its two neighbours and rounded to a
 * whole dollar: with 2 hours at $230 and 3 hours at $320, 2.5 hours is $275. `stepMinutes` is the owners' setting
 * (`betweenLengthsMinutes`): every half hour, every hour, or 0 for none. Nothing shorter than the shortest listed
 * length or longer than the longest: the owners list a longer one to sell it. A rule built on the builder's reading
 * (question 83 in ProjectLibrary.md).
 */
export function betweenLengths(listed: readonly { durationMinutes: number; priceCents: number }[], stepMinutes: number): { durationMinutes: number; priceCents: number }[] {
  if (!(Number.isInteger(stepMinutes) && stepMinutes > 0)) return [];
  const sorted = [...listed].sort((a, b) => a.durationMinutes - b.durationMinutes);
  const out: { durationMinutes: number; priceCents: number }[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const [from, to] = [sorted[i], sorted[i + 1]];
    for (let minutes = (Math.floor(from.durationMinutes / stepMinutes) + 1) * stepMinutes; minutes < to.durationMinutes; minutes += stepMinutes) {
      const exact = from.priceCents + ((to.priceCents - from.priceCents) * (minutes - from.durationMinutes)) / (to.durationMinutes - from.durationMinutes);
      out.push({ durationMinutes: minutes, priceCents: Math.round(exact / 100) * 100 });
    }
  }
  return out;
}

/** The studios' price rules with the lengths between the listed ones (`betweenLengths`), for each studio and kind of day. */
export function rulesWithBetween(rules: readonly PriceRule[], stepMinutes: number): PriceRule[] {
  const out = [...rules];
  const groups = new Map<string, PriceRule[]>();
  for (const rule of rules) groups.set(`${rule.studioId} ${rule.dayType}`, [...(groups.get(`${rule.studioId} ${rule.dayType}`) ?? []), rule]);
  for (const group of groups.values()) {
    for (const made of betweenLengths(group, stepMinutes)) out.push({ studioId: group[0].studioId, dayType: group[0].dayType, ...made, between: true });
  }
  return out;
}

/** The same for the bundles' prices, each bundle's list by itself. */
export function bundlePricesWithBetween(bundlePrices: readonly BundlePrice[], stepMinutes: number): BundlePrice[] {
  const out = [...bundlePrices];
  const groups = new Map<string, BundlePrice[]>();
  for (const price of bundlePrices) {
    const key = bundleKey(price.studioIds);
    groups.set(key, [...(groups.get(key) ?? []), price]);
  }
  for (const group of groups.values()) {
    for (const made of betweenLengths(group, stepMinutes)) out.push({ studioIds: group[0].studioIds, ...made, between: true });
  }
  return out;
}

/**
 * The lengths these studios can be booked for on that kind of day: a bundle's own list when the owners gave it one,
 * else the lengths every chosen studio has a price for.
 */
export function bookableDurations(studioIds: string[], dayType: DayType, rules: PriceRule[], bundlePrices: readonly BundlePrice[]): number[] {
  if (studioIds.length === 0) return [];
  const together = bundleList(studioIds, bundlePrices);
  if (together.length > 0) return together.map((price) => price.durationMinutes).sort((a, b) => a - b);
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

/**
 * What stops these studios being priced for that length on that kind of day, or null when they have a price: the
 * bundle's list has no such length (`together`), or these studios have none of their own.
 */
export function unpriced(
  studioIds: readonly string[],
  dayType: DayType,
  durationMinutes: number,
  rules: PriceRule[],
  bundlePrices: readonly BundlePrice[],
): { studioIds: string[]; together: boolean } | null {
  const together = bundleList(studioIds, bundlePrices);
  if (together.length > 0) return together.some((price) => price.durationMinutes === durationMinutes) ? null : { studioIds: [...studioIds], together: true };
  const missing = studioIds.filter((id) => findPrice(id, dayType, durationMinutes, rules) === null);
  return missing.length > 0 ? { studioIds: missing, together: false } : null;
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
  // Studios with a price list together cost what it says, on any day, and nothing more comes off for booking several.
  const together = photoPackage ? [] : bundleList(studioIds, input.bundlePrices);
  const own = (studioId: string) => findPrice(studioId, dayType, durationMinutes, rules);
  let studioLines: Quote["studioLines"];
  if (together.length > 0) {
    const listed = together.find((price) => price.durationMinutes === durationMinutes);
    if (!listed) throw new PricingError("NO_PRICE", "That duration is not offered for the selected studios.");
    const shares = shareOf(listed.priceCents, studioIds.map(own));
    studioLines = studioIds.map((studioId, index) => ({ studioId, priceCents: shares[index] }));
  } else {
    studioLines = studioIds.map((studioId) => {
      // A session's price includes the studio, so the studio's own price list is not consulted.
      const priceCents = photoPackage ? photoPackage.priceCents : own(studioId);
      if (priceCents === null) {
        throw new PricingError("NO_PRICE", "That duration is not offered for the selected studios.");
      }
      return { studioId, priceCents };
    });
  }
  const studiosSubtotalCents = studioLines.reduce((sum, l) => sum + l.priceCents, 0);

  const multiStudioPercent = together.length > 0 ? 0 : multiStudioPercentFor(studioIds.length, input.multiStudioPercent);
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
    promoMisfit = photoPackage ? (photoPackage.service === "content" ? "content" : "photography") : "rental";
  } else if (promo && input.bookingDay && !promoFitsDay(promo.days, input.bookingDay.date, input.bookingDay.special)) {
    promoMisfit = "day";
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
    // A bundle with prices together costs the same on every day, so its weekend time has no weekday price to differ from.
    if (membership.weekendDifference && dayType === "weekend" && together.length === 0) {
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
