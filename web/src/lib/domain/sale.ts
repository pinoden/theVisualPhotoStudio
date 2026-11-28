/**
 * A sale: the studios' prices lowered for a while, by the owners, with no deployment (the owner, 2026-11-27: "it is
 * Black Friday weekend and the owner wants to decrease the price for one or whole studios … and I want the price be
 * crossed out, like not 78 but 65 … only today and tomorrow"). Pure functions: the booking screen works a sale out in
 * the browser, and the server works it out again for what is charged.
 *
 * A sale has the days it can be booked on, and, when the owners say so, the days of studio time it is for. It takes a
 * percentage off the studios it names (none named: every studio), and the price on sale is a whole number of dollars.
 * It lowers what a studio costs, alone or with others; a session with the studio's photographer or content creator
 * has a price of its own and is never on sale, and neither is an add-on. `quote` (pricing.ts) takes the sale a booking
 * is made under and says what it took off. What the builder read into the request is question 87 in
 * ProjectLibrary.md.
 */
import { listInWords } from "../words";
import type { BundlePrice, PriceRule } from "./pricing";
import { longDateLabel, type IsoDate } from "./time";

export interface Sale {
  id: string;
  /** What clients read: "Black Friday". */
  name: string;
  /** What comes off, in percent: 1 to 90. */
  percent: number;
  /** The studios on sale. Empty: every studio. */
  studioIds: string[];
  /** The first and the last day a booking can be made at the sale's prices. */
  bookFrom: IsoDate;
  bookUntil: IsoDate;
  /** The days of studio time it is for, when the owners limit them: either end may be open. */
  visitFrom: IsoDate | null;
  visitUntil: IsoDate | null;
}

export const SALE_PERCENT_MAX = 90;

/**
 * What a booking keeps of the sales it was made under: what comes off each of its studios, and the sales' names. Kept
 * with the booking, so that a move or a change by the studio prices it as it was sold, whatever the sales are by then.
 */
export interface BookingSale {
  name: string;
  /** Studio id -> percent off. A studio that is not on sale is left out. */
  percents: Record<string, number>;
}

/** Whether a sale can be booked on `bookedOn`, whatever the day of the studio time. */
export function bookableOn(sale: Sale, bookedOn: IsoDate): boolean {
  return sale.bookFrom <= bookedOn && bookedOn <= sale.bookUntil;
}

/** Whether a sale is for studio time on `date`. */
function coversDay(sale: Sale, date: IsoDate): boolean {
  return (sale.visitFrom === null || sale.visitFrom <= date) && (sale.visitUntil === null || date <= sale.visitUntil);
}

/**
 * The sales a booking made on `bookedOn` gets. With `date`, for studio time on that day; without, whatever the day,
 * as a price list shows them before a day is chosen.
 */
export function salesInForce(sales: readonly Sale[], bookedOn: IsoDate, date?: IsoDate | null): Sale[] {
  return sales.filter((sale) => bookableOn(sale, bookedOn) && (!date || coversDay(sale, date)));
}

/**
 * What sales in force take off these studios: for each, the most any one sale takes off it. Sales do not add up. Null
 * when none of the studios is on sale.
 */
export function bookingSale(sales: readonly Sale[], studioIds: readonly string[]): BookingSale | null {
  const percents: Record<string, number> = {};
  const names: string[] = [];
  for (const studioId of studioIds) {
    const best = sales
      .filter((sale) => sale.studioIds.length === 0 || sale.studioIds.includes(studioId))
      .reduce<Sale | null>((most, sale) => (most === null || sale.percent > most.percent ? sale : most), null);
    if (!best || best.percent <= 0) continue;
    percents[studioId] = best.percent;
    if (!names.includes(best.name)) names.push(best.name);
  }
  return names.length > 0 ? { name: names.join(" + "), percents } : null;
}

/** A price with a percentage off, in whole dollars, and never more than the price itself. */
export function salePriceCents(cents: number, percent: number): number {
  if (percent <= 0) return cents;
  return Math.min(cents, Math.round((cents * (100 - percent)) / 10_000) * 100);
}

/**
 * What comes off studios booked together at a price of their own: the least that comes off any one of them, so
 * nothing while one of them is not on sale. A bundle is on sale when each of its studios is.
 */
export function bundlePercent(percents: Record<string, number>, studioIds: readonly string[]): number {
  return studioIds.length === 0 ? 0 : Math.min(...studioIds.map((id) => percents[id] ?? 0));
}

/** A price that a sale lowered keeps the usual one, to be shown crossed out. */
export type OnSale<T> = T & { usualCents?: number };

/**
 * The price lists as a booking under `sale` pays them. A price the sale lowers keeps the usual one (`usualCents`);
 * the others are as they were. With no sale, the lists themselves.
 */
export function listsOnSale(
  rules: readonly PriceRule[],
  bundlePrices: readonly BundlePrice[],
  sale: Pick<BookingSale, "percents"> | null,
): { rules: OnSale<PriceRule>[]; bundlePrices: OnSale<BundlePrice>[] } {
  if (!sale) return { rules: [...rules], bundlePrices: [...bundlePrices] };
  const lowered = <T extends { priceCents: number }>(row: T, percent: number): OnSale<T> => {
    const priceCents = salePriceCents(row.priceCents, percent);
    return priceCents < row.priceCents ? { ...row, priceCents, usualCents: row.priceCents } : row;
  };
  return {
    rules: rules.map((rule) => lowered(rule, sale.percents[rule.studioId] ?? 0)),
    bundlePrices: bundlePrices.map((price) => lowered(price, bundlePercent(sale.percents, price.studioIds))),
  };
}

/**
 * The sale a booking of these studios is made under, made on `bookedOn` for studio time on `date`: null for none.
 * The caller leaves a session out: it is never on sale.
 */
export function saleFor(sales: readonly Sale[], bookedOn: IsoDate, date: IsoDate, studioIds: readonly string[]): BookingSale | null {
  return bookingSale(salesInForce(sales, bookedOn, date), studioIds);
}

/**
 * What a sale says of itself, for a price list and the booking screen: "17% off every studio when you book by
 * Saturday, November 28, 2026", and the days of studio time when the owners limited them.
 */
export function saleWords(sale: Sale, studios: readonly { id: string; name: string }[]): string {
  const named = studios.filter((studio) => sale.studioIds.includes(studio.id)).map((studio) => studio.name);
  const what = sale.studioIds.length === 0 || named.length === studios.length ? "every studio" : listInWords(named);
  const time =
    sale.visitFrom && sale.visitUntil
      ? sale.visitFrom === sale.visitUntil
        ? `, for studio time on ${longDateLabel(sale.visitFrom)}`
        : `, for studio time from ${longDateLabel(sale.visitFrom)} to ${longDateLabel(sale.visitUntil)}`
      : sale.visitFrom
        ? `, for studio time from ${longDateLabel(sale.visitFrom)} on`
        : sale.visitUntil
          ? `, for studio time until ${longDateLabel(sale.visitUntil)}`
          : "";
  return `${sale.percent}% off ${what} when you book by ${longDateLabel(sale.bookUntil)}${time}`;
}
