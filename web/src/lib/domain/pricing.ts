/**
 * Price calculation. Pure functions, amounts in integer cents.
 *
 * The same code runs in the browser (instant preview) and on the server
 * (the only result that is ever charged).
 */
import { promoDayMisfitText, promoFitsDay, type PromoDays } from "./promo-days";
import { listsOnSale, type BookingSale } from "./sale";
import type { DayType, IsoDate } from "./time";

export interface PriceRule {
  studioId: string;
  dayType: DayType;
  durationMinutes: number;
  priceCents: number;
  /** Worked out from the listed lengths (`betweenLengths`), not typed in by the owners: the price lists leave it out. */
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
  /**
   * An amount that is a discount, not money paid before: it comes off the price before sales tax, as a percent code
   * does. Left out, an amount is credit (a reschedule code, studio credit), which pays the total, tax included.
   */
  beforeTax?: boolean;
}

/**
 * Sales tax, added on top of the prices (the owner's decision of 2026-11-20: "Prices exclude sales tax. Show a separate
 * line at checkout and on receipts", at 6.5% until the accountant confirms the rate and what it applies to). What it
 * applies to is the builder's reading until then (question 84 in ProjectLibrary.md): the price after discounts and
 * membership hours, rounded to a cent; credit pays the total, tax included.
 */
export interface TaxRule {
  /** The rate in hundredths of a percent: 650 is 6.5%. 0: no tax. */
  basisPoints: number;
  /** Whether the studio part of the price is taxed: the studios' time, or a session's price. */
  studio: boolean;
  /** Whether what is chosen with the booking is taxed: add-ons, extra guests, fees. */
  addons: boolean;
}

/** The highest rate the owners can set: 20%. */
export const TAX_BASIS_POINTS_MAX = 2000;

/** The owners' tax settings as they apply to one booking: a rental, or a session (photography, content creation). */
export function taxRuleFor(
  settings: { salesTaxBasisPoints: number; taxStudioTime: boolean; taxSessions: boolean; taxAddons: boolean },
  session: boolean,
): TaxRule {
  return { basisPoints: settings.salesTaxBasisPoints, studio: session ? settings.taxSessions : settings.taxStudioTime, addons: settings.taxAddons };
}

/** The rule kept with a booking (`bookings.tax_*`): the one it was made under, which a move or a change prices it by again. */
export function taxRuleOf(booking: { taxBasisPoints: number; taxStudio: boolean; taxAddons: boolean }): TaxRule {
  return { basisPoints: booking.taxBasisPoints, studio: booking.taxStudio, addons: booking.taxAddons };
}

/** "6.5%", "7%", "6.75%". */
export function taxPercent(basisPoints: number): string {
  return `${Number((basisPoints / 100).toFixed(2))}%`;
}

/** The tax line's label: "Sales tax (6.5%)". */
export function taxLabel(basisPoints: number): string {
  return `Sales tax (${taxPercent(basisPoints)})`;
}

/** Why a code that exists cannot be used on a selection. */
export type PromoMisfit = "several_studios" | "photography" | "content" | "rental" | "day" | "sale";

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
  sale: "A discount code is not used on top of a sale's price, and the sale's price is the lower of the two for this booking.",
};

/**
 * Whether a code takes something off a price, as a sale does: a percentage, an amount off, a free hour. An amount that
 * is credit (a reschedule code, studio credit) is money paid before, and pays a sale's price like any other.
 */
const isDiscountCode = (promo: Pick<PromoDef, "kind" | "beforeTax">): boolean => promo.kind !== "amount" || promo.beforeTax === true;

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
  /** The sales tax to add. Left out, or at a rate of 0: none. */
  tax?: TaxRule | null;
  /**
   * The sale the booking is made under (sale.ts): what comes off each studio. `rules` and `bundlePrices` are the usual
   * lists; the sale lowers them here. Never for a session, which has a price of its own. Unless the sale says so
   * (`withCodes`), a discount code is not used on top of it: see `quote`.
   */
  sale?: Pick<BookingSale, "percents" | "withCodes"> | null;
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
  /**
   * What the code takes off or pays. A discount (a percent code, a free hour) comes off the price before tax. Credit (an
   * amount) pays the total, so it can be more than the prices add up to: it pays the tax too.
   */
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
  /** The sales tax, and the rate it was worked out at (0 when none applies). Part of `totalCents`. */
  taxCents: number;
  taxBasisPoints: number;
  /** What is left to pay: the prices, less discounts and membership hours, plus tax, less credit. */
  totalCents: number;
  /**
   * Only when a sale lowered the studios' prices: what it took off them, after the discount for several studios, and
   * the studios' lines as they would be without it, in the order of `studioLines`, to show crossed out.
   */
  saleCents?: number;
  usualStudioLines?: { studioId: string; priceCents: number }[];
  /**
   * Only when the booking is under a sale that a discount code set aside: the code takes more off than the sale would,
   * and the two are not combined. The prices are then the usual ones, with the code.
   */
  saleSetAside?: true;
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
  | "BAD_PACKAGE"
  | "BAD_TAX";

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

/** One row of a booking's price, above its tax and its total: a studio's price, an add-on, or what a discount took off (negative). */
export interface PriceRow {
  label: string;
  cents: number;
}

/**
 * A booking's price row by row, as its own page lists it (`BookingSummary`): the studios (`studioPriceLines`), the
 * discount for several of them, each add-on, and what a percent code or a free hour took off. Credit and membership
 * hours are not among them: they pay the total. For the confirmation email, which gave only the total until
 * 2026-11-27 (the preview test of 2026-11-21, point 3: six extra guests paid for, and no line for them).
 */
export function priceRows(input: {
  studios: readonly { name: string; priceCents: number }[];
  multiStudioDiscountCents: number;
  addons: readonly { name: string; quantity: number; unitCents: number }[];
  /** A percent code or a free hour, and what it took off; null for none, and for credit. */
  discount: { kind: PromoKind; cents: number } | null;
}): PriceRow[] {
  return [
    ...studioPriceLines(input.studios, input.multiStudioDiscountCents).map((studio) => ({ label: studio.name, cents: studio.priceCents })),
    ...(input.multiStudioDiscountCents > 0 ? [{ label: "Multi-studio discount", cents: -input.multiStudioDiscountCents }] : []),
    ...input.addons.map((addon) => ({ label: addon.quantity > 1 ? `${addon.name} × ${addon.quantity}` : addon.name, cents: addon.unitCents * addon.quantity })),
    ...(input.discount && input.discount.kind !== "amount" && input.discount.cents > 0
      ? [{ label: input.discount.kind === "free_hour" ? "Free hour" : "Discount code", cents: -input.discount.cents }]
      : []),
  ];
}

/**
 * The lengths the owners did not list that can be booked, each priced on the straight line through the listed ones and
 * rounded to a whole dollar. `stepMinutes` is the owners' setting (`betweenLengthsMinutes`): every half hour, every
 * hour, or 0 for the listed lengths only.
 *
 * - Between two listed lengths, between their prices: with 2 hours at $230 and 3 hours at $320, 2.5 hours is $275.
 * - Past the longest listed length, up to `longestMinutes` (the owners' setting `longestBookingMinutes`), the last two
 *   listed lengths' rise goes on: with 4 hours at $400 and 5 at $490, 6 hours is $580. With one length listed, its
 *   price per hour. The owner, 2026-11-25: "Times options should be the same for every studio 1-10 hours".
 * - Nothing shorter than the shortest listed length.
 *
 * How such a length is priced the owner approved on 2026-11-25 ("OK on prices"; question 83 in ProjectLibrary.md). A duration the owners list
 * always costs what they typed, and is sold even when it is longer than `longestMinutes`.
 */
export function betweenLengths(
  listed: readonly { durationMinutes: number; priceCents: number }[],
  stepMinutes: number,
  longestMinutes = 0,
): { durationMinutes: number; priceCents: number }[] {
  if (!(Number.isInteger(stepMinutes) && stepMinutes > 0) || listed.length === 0) return [];
  const sorted = [...listed].sort((a, b) => a.durationMinutes - b.durationMinutes);
  const out: { durationMinutes: number; priceCents: number }[] = [];
  const onLine = (from: { durationMinutes: number; priceCents: number }, perMinute: number, minutes: number) =>
    out.push({ durationMinutes: minutes, priceCents: Math.round((from.priceCents + perMinute * (minutes - from.durationMinutes)) / 100) * 100 });
  const firstAfter = (minutes: number) => (Math.floor(minutes / stepMinutes) + 1) * stepMinutes;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const [from, to] = [sorted[i], sorted[i + 1]];
    const perMinute = (to.priceCents - from.priceCents) / (to.durationMinutes - from.durationMinutes);
    for (let minutes = firstAfter(from.durationMinutes); minutes < to.durationMinutes; minutes += stepMinutes) onLine(from, perMinute, minutes);
  }
  const last = sorted[sorted.length - 1];
  const before = sorted.length > 1 ? sorted[sorted.length - 2] : { durationMinutes: 0, priceCents: 0 };
  const rise = (last.priceCents - before.priceCents) / (last.durationMinutes - before.durationMinutes);
  for (let minutes = firstAfter(last.durationMinutes); minutes <= longestMinutes; minutes += stepMinutes) onLine(last, rise, minutes);
  return out;
}

/** The studios' price rules with the lengths the owners did not list (`betweenLengths`), for each studio and kind of day. */
export function rulesWithBetween(rules: readonly PriceRule[], stepMinutes: number, longestMinutes = 0): PriceRule[] {
  const out = [...rules];
  const groups = new Map<string, PriceRule[]>();
  for (const rule of rules) groups.set(`${rule.studioId} ${rule.dayType}`, [...(groups.get(`${rule.studioId} ${rule.dayType}`) ?? []), rule]);
  for (const group of groups.values()) {
    for (const made of betweenLengths(group, stepMinutes, longestMinutes)) out.push({ studioId: group[0].studioId, dayType: group[0].dayType, ...made, between: true });
  }
  return out;
}

/** The same for the bundles' prices, each bundle's list by itself. */
export function bundlePricesWithBetween(bundlePrices: readonly BundlePrice[], stepMinutes: number, longestMinutes = 0): BundlePrice[] {
  const out = [...bundlePrices];
  const groups = new Map<string, BundlePrice[]>();
  for (const price of bundlePrices) {
    const key = bundleKey(price.studioIds);
    groups.set(key, [...(groups.get(key) ?? []), price]);
  }
  for (const group of groups.values()) {
    for (const made of betweenLengths(group, stepMinutes, longestMinutes)) out.push({ studioIds: group[0].studioIds, ...made, between: true });
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

/**
 * What a booking costs.
 *
 * A sale's price and a discount code are not combined (the owner, 2026-11-28: "Either or, not combine"; question 88 in
 * ProjectLibrary.md): the client pays the lower of the two totals. When the sale's price is the lower one, or they are
 * the same, the code is not used and stays theirs (`promoMisfit` "sale"); when the code takes more off, the usual
 * prices are charged with the code, and the sale is set aside (`saleSetAside`). Credit pays a sale's price like any
 * other price, and so do membership hours. A sale the owners ticked "with codes" for takes a code on top.
 */
export function quote(input: QuoteInput): Quote {
  const priced = priceOf(input);
  const promo = input.promo;
  if (!priced.saleCents || input.sale?.withCodes || !promo || !isDiscountCode(promo) || priced.promoMisfit || priced.promoDiscountCents === 0) return priced;
  const onSale = priceOf({ ...input, promo: null });
  const withCode = priceOf({ ...input, sale: null });
  return withCode.totalCents < onSale.totalCents ? { ...withCode, saleSetAside: true } : { ...onSale, promoMisfit: "sale" };
}

function priceOf(input: QuoteInput): Quote {
  const { studioIds, dayType, durationMinutes } = input;
  const sale = input.sale && !input.photoPackage ? input.sale : null;
  const { rules, bundlePrices } = listsOnSale(input.rules, input.bundlePrices, sale);
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
  const together = photoPackage ? [] : bundleList(studioIds, bundlePrices);
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
  // A discount comes off the price before tax. Credit is money paid before: it pays the total, tax included.
  let discountCents = 0;
  let creditCents = 0;
  let promoMisfit: PromoMisfit | null = null;
  const promo = input.promo;
  if (promo && (promo.photographyOnly === true) !== Boolean(photoPackage)) {
    promoMisfit = photoPackage ? (photoPackage.service === "content" ? "content" : "photography") : "rental";
  } else if (promo && input.bookingDay && !promoFitsDay(promo.days, input.bookingDay.date, input.bookingDay.special)) {
    promoMisfit = "day";
  } else if (promo) {
    if (promo.kind === "percent") {
      if (!(promo.value > 0 && promo.value <= 100)) throw new PricingError("BAD_PROMO", "Invalid code.");
      discountCents = percentOf(studiosNetCents, promo.value);
    } else if (promo.kind === "amount") {
      if (!(Number.isInteger(promo.value) && promo.value > 0)) throw new PricingError("BAD_PROMO", "Invalid code.");
      if (promo.beforeTax) discountCents = Math.min(promo.value, studiosNetCents + addonsCents);
      else creditCents = promo.value;
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
        discountCents = Math.min(worth, line.priceCents);
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
    membershipCents = Math.min(Math.max(0, studiosNetCents - discountCents), Math.round((basisCents * membershipMinutes) / durationMinutes));
  }

  // What is left of each part after discounts and membership hours: a discount comes off the studio price first.
  const offStudioCents = Math.min(discountCents, studiosNetCents);
  const studioPartCents = studiosNetCents - offStudioCents - membershipCents;
  const addonsPartCents = addonsCents - (discountCents - offStudioCents);
  const tax = input.tax && input.tax.basisPoints > 0 ? input.tax : null;
  if (tax && !(Number.isInteger(tax.basisPoints) && tax.basisPoints <= TAX_BASIS_POINTS_MAX)) throw new PricingError("BAD_TAX", "The sales tax rate is not valid.");
  const taxCents = tax ? Math.round((((tax.studio ? studioPartCents : 0) + (tax.addons ? addonsPartCents : 0)) * tax.basisPoints) / 10_000) : 0;
  const beforeCreditCents = studioPartCents + addonsPartCents + taxCents;
  creditCents = Math.min(creditCents, beforeCreditCents);

  // Under a sale: what the studios would cost without it, to say what it took off.
  const usual = sale ? priceOf({ ...input, sale: null, addons: [], promo: null, membership: null, tax: null }) : null;
  const saleCents = usual ? usual.studiosSubtotalCents - usual.multiStudioDiscountCents - (studiosSubtotalCents - multiStudioDiscountCents) : 0;

  return {
    studioLines,
    studiosSubtotalCents,
    multiStudioPercent,
    multiStudioDiscountCents,
    addonLines,
    addonsCents,
    promoDiscountCents: discountCents + creditCents,
    promoMisfit,
    membershipMinutes,
    membershipCents,
    taxCents,
    taxBasisPoints: tax ? tax.basisPoints : 0,
    totalCents: beforeCreditCents - creditCents,
    ...(usual && saleCents > 0 ? { saleCents, usualStudioLines: usual.studioLines } : {}),
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
