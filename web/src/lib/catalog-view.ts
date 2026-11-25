import { appointmentLook } from "@/lib/domain/appointment-look";
import type { Catalog, CatalogStudio } from "@/server/catalog";
import { extraGuestsAllowed, formatCents, multiStudioPercentFor } from "@/lib/domain/pricing";
import { durationLabel, weekdayName, minutesToLabel } from "@/lib/domain/time";

/** Blanche and Dayglow can be reserved together as part of the three-studio bundle. */
export function studioCombinationError(studios: readonly Pick<CatalogStudio, "id" | "slug">[], studioIds: readonly string[]): string | null {
  if (studioIds.length < 2) return null;
  const slugs = new Set(studios.filter((studio) => studioIds.includes(studio.id)).map((studio) => studio.slug));
  if (slugs.has("blanche") && slugs.has("dayglow") && !slugs.has("paris")) {
    return "To book Blanche and Dayglow together, add Paris or choose a different combination.";
  }
  return null;
}

/** Lowest weekday price for one hour, used for "from $X/hour" labels. */
/**
 * How many extra guests a booking of these studios can take (`extraGuestsAllowed`), from the studios and the owners'
 * limits for studios booked together. The booking screen and the server ask the same.
 */
export function extraGuestsFor(catalog: Pick<Catalog, "studios" | "settings">, studioIds: readonly string[]): number {
  const chosen = catalog.studios.filter((studio) => studioIds.includes(studio.id));
  return extraGuestsAllowed(chosen, { 2: catalog.settings.twoStudioGuestLimit, 3: catalog.settings.threeStudioGuestLimit });
}

export function hourlyFromCents(catalog: Catalog, studioId: string): number | null {
  const prices = catalog.rules
    .filter((r) => r.studioId === studioId && r.durationMinutes === 60)
    .map((r) => r.priceCents);
  return prices.length > 0 ? Math.min(...prices) : null;
}

/**
 * Price rows for a studio: one per duration the owners list, with weekday and weekend prices. The lengths between
 * (`between`) are left out: they are worked out from these.
 */
export function priceTable(
  catalog: Pick<Catalog, "rules">,
  studioId: string,
): { durationMinutes: number; weekdayCents: number | null; weekendCents: number | null }[] {
  const rules = catalog.rules.filter((r) => r.studioId === studioId && !r.between);
  const durations = [...new Set(rules.map((r) => r.durationMinutes))].sort((a, b) => a - b);
  return durations.map((durationMinutes) => ({
    durationMinutes,
    weekdayCents: rules.find((r) => r.durationMinutes === durationMinutes && r.dayType === "weekday")?.priceCents ?? null,
    weekendCents: rules.find((r) => r.durationMinutes === durationMinutes && r.dayType === "weekend")?.priceCents ?? null,
  }));
}

/**
 * What studios booked together are called: "All three studios" for every studio of three or more, else the calendar's
 * name for them, which is the owner's for the bundles they named ("Paris + Dayglow", "Paris + Blanche":
 * `appointmentLook`). One studio, its name.
 */
export function bundleName(catalog: Pick<Catalog, "studios">, studioIds: readonly string[]): string {
  const held = studioIds.flatMap((id) => catalog.studios.find((studio) => studio.id === id) ?? []);
  if (held.length === 1) return held[0].name;
  if (held.length > 2 && held.length === catalog.studios.length) return `All ${inWords(held.length)} studios`;
  return appointmentLook(held, false).name;
}

/** A bundle with prices of its own: the prices the owners list, shortest first (the lengths between are left out). */
export interface BundleTable {
  studioIds: string[];
  name: string;
  prices: { durationMinutes: number; priceCents: number }[];
}

/** The bundles with prices of their own: the fewest studios first, then the lowest price for the shortest length. */
export function bundleTables(catalog: Pick<Catalog, "studios" | "bundlePrices">): BundleTable[] {
  const tables = new Map<string, BundleTable>();
  for (const price of catalog.bundlePrices) {
    if (price.between) continue;
    const key = price.studioIds.join("+");
    const table = tables.get(key) ?? { studioIds: price.studioIds, name: bundleName(catalog, price.studioIds), prices: [] };
    table.prices.push({ durationMinutes: price.durationMinutes, priceCents: price.priceCents });
    tables.set(key, table);
  }
  for (const table of tables.values()) table.prices.sort((a, b) => a.durationMinutes - b.durationMinutes);
  return [...tables.values()].sort((a, b) => a.studioIds.length - b.studioIds.length || a.prices[0].priceCents - b.prices[0].priceCents);
}

/**
 * The lengths every studio and bundle can be booked for, in words: "1 to 10 hours". From the shortest any of them
 * takes to the longest. Empty without prices.
 */
export function bookingLengths(catalog: Pick<Catalog, "rules" | "bundlePrices">): string {
  const all = [...catalog.rules, ...catalog.bundlePrices].map((row) => row.durationMinutes);
  if (all.length === 0) return "";
  const [shortest, longest] = [Math.min(...all), Math.max(...all)];
  if (shortest === longest) return durationLabel(shortest);
  const last = durationLabel(longest);
  const first = durationLabel(shortest);
  // "1 to 10 hours" rather than "1 hour to 10 hours".
  return shortest % 30 === 0 && shortest >= 60 && longest % 30 === 0 ? `${shortest / 60} to ${last}` : `${first} to ${last}`;
}

/**
 * The lengths the booking screen shows at first, and those behind "More": the owners' list (`shownLengthsMinutes`, 1,
 * 2, 3, 4 and 6 hours as it starts), those of them the selection offers. When it offers none of them, as many of its
 * own, the shortest whole hours first. A selection with no more lengths than the list has shows them all, without
 * "More". Both shortest first.
 */
export function shownLengths(durations: readonly number[], firstShown: readonly number[]): { shown: number[]; more: number[] } {
  const sorted = [...durations].sort((a, b) => a - b);
  if (sorted.length <= firstShown.length) return { shown: sorted, more: [] };
  const wholeFirst = [...sorted.filter((minutes) => minutes % 60 === 0), ...sorted.filter((minutes) => minutes % 60 !== 0)];
  const listed = sorted.filter((minutes) => firstShown.includes(minutes));
  const shown = new Set(listed.length > 0 ? listed : wholeFirst.slice(0, Math.max(firstShown.length, 1)));
  return { shown: sorted.filter((minutes) => shown.has(minutes)), more: sorted.filter((minutes) => !shown.has(minutes)) };
}

/**
 * The booking page's sentence about the bundles that have prices of their own: "Bundle prices: Paris + Dayglow from
 * $115, Paris + Blanche from $140, all three studios from $180". It stands where "Save 20% when booking two studios…"
 * stood while a bundle was a percentage off (question 81 (c)). Empty when no bundle has prices.
 */
export function bundleOffer(catalog: Pick<Catalog, "studios" | "bundlePrices">): string {
  const parts = bundleTables(catalog).map((table) => `${table.name.replace(/^All /, "all ")} from ${formatCents(Math.min(...table.prices.map((price) => price.priceCents)))}`);
  return parts.length > 0 ? `Bundle prices: ${parts.join(", ")}` : "";
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const inWords = (n: number) => NUMBER_WORDS[n] ?? String(n);

/**
 * The booking page's sentence about booking several studios, in the owner's words of 2026-11-22: "Save 20% when
 * booking two studios and 22% when booking three studios", with the numbers of studios in words. It counts up to the
 * number of studios the site offers, so it never speaks of more studios than can be booked, and asks the pricing
 * function what each number gets, as `multiStudioOffer` does. Empty when no discount is set or the site has one studio.
 */
export function multiStudioSaving(catalog: Pick<Catalog, "settings" | "studios" | "bundlePrices">): string {
  // Bundles with prices of their own are not a percentage off anything: `bundleOffer` speaks for them.
  if (catalog.bundlePrices.length > 0) return "";
  const table = catalog.settings.multiStudioPercent;
  const runs: { from: number; to: number; percent: number }[] = [];
  for (let n = 2; n <= catalog.studios.length; n++) {
    const percent = multiStudioPercentFor(n, table);
    const last = runs.at(-1);
    if (last && last.percent === percent) last.to = n;
    else runs.push({ from: n, to: n, percent });
  }
  const parts = runs
    .filter((run) => run.percent > 0)
    .map((run) => {
      const studios =
        run.from === run.to
          ? inWords(run.from)
          : `${inWords(run.from)} ${run.to === run.from + 1 ? "or" : "to"} ${inWords(run.to)}`;
      return `${run.percent}% when booking ${studios} studios`;
    });
  if (parts.length === 0) return "";
  const listed = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `Save ${listed}`;
}

/** True when any studio charges a different price on weekends. */
export function hasWeekendPricing(catalog: Catalog): boolean {
  return catalog.studios.some((s) =>
    priceTable(catalog, s.id).some((row) => row.weekdayCents !== row.weekendCents),
  );
}

/**
 * "20% off when you book 2, 22% off when you book 3 or more"; empty when no
 * discount is set.
 *
 * It asks the pricing function what each number of studios gets, so the
 * sentence cannot promise more than is charged. With 15% for two and 0% for
 * three it says "15% off when you book exactly 2", never "2 or more".
 */
export function multiStudioOffer(catalog: Pick<Catalog, "settings" | "bundlePrices">): string {
  // As `multiStudioSaving`: with prices for the bundles, the pages show those (the block "Prices of the bundles").
  if (catalog.bundlePrices.length > 0) return "";
  const table = catalog.settings.multiStudioPercent;
  const highest = Math.max(2, ...Object.keys(table).map(Number).filter((n) => Number.isInteger(n) && n >= 2));
  // Runs of studio counts that get the same percentage. The last one goes on for any larger number.
  const runs: { from: number; to: number; percent: number }[] = [];
  for (let n = 2; n <= highest; n++) {
    const percent = multiStudioPercentFor(n, table);
    const last = runs.at(-1);
    if (last && last.percent === percent) last.to = n;
    else runs.push({ from: n, to: n, percent });
  }
  return runs
    .map((run, index) => {
      if (run.percent <= 0) return "";
      if (index === runs.length - 1) return `${run.percent}% off when you book ${run.from} or more`;
      const exactly = runs.slice(index + 1).every((later) => later.percent <= 0) ? "exactly " : "";
      return `${run.percent}% off when you book ${exactly}${run.from === run.to ? run.from : `${run.from} to ${run.to}`}`;
    })
    .filter(Boolean)
    .join(", ");
}

/**
 * Where pets can be booked and what it costs, from the add-ons on offer. A
 * studio takes pets when a pet add-on can be booked with it: its own, or one
 * for any booking. Read by the guest information and the policies page, so
 * both follow what the owner offers and not what an add-on happens to be called.
 */
export function petPolicy(catalog: Pick<Catalog, "studios" | "addons">): {
  /** The studios that take pets. Empty when no pet add-on is offered. */
  studios: string[];
  /** The studios that do not. */
  petFreeStudios: string[];
  /** The fee for each studio that takes pets: its own add-on if it has one, else the one for any booking. */
  fees: { studio: string; cents: number }[];
  /** True when every studio that takes pets charges the same fee. */
  oneFee: boolean;
} {
  const petAddons = catalog.addons.filter((addon) => addon.kind === "pet");
  const anywhere = petAddons.find((addon) => addon.studioId === null);
  const welcoming = catalog.studios.filter((studio) => anywhere || petAddons.some((addon) => addon.studioId === studio.id));
  const fees = welcoming.map((studio) => ({
    studio: studio.name,
    cents: (petAddons.find((addon) => addon.studioId === studio.id) ?? anywhere)!.priceCents,
  }));
  return {
    studios: welcoming.map((studio) => studio.name),
    petFreeStudios: catalog.studios.filter((studio) => !welcoming.includes(studio)).map((studio) => studio.name),
    fees,
    oneFee: fees.every((fee) => fee.cents === fees[0].cents),
  };
}

/** "Mon-Fri 9:00 AM - 7:00 PM" style lines, grouping consecutive days with equal hours. */
export function hoursLines(studio: CatalogStudio): string[] {
  const lines: string[] = [];
  let runStart = 1;
  const key = (weekday: number) => {
    const h = studio.hours[weekday];
    return h ? `${h.openMinute}-${h.closeMinute}` : "closed";
  };
  for (let weekday = 1; weekday <= 7; weekday++) {
    if (weekday < 7 && key(weekday + 1) === key(runStart)) continue;
    const h = studio.hours[runStart];
    const days =
      runStart === weekday
        ? weekdayName(runStart).slice(0, 3)
        : `${weekdayName(runStart).slice(0, 3)}–${weekdayName(weekday).slice(0, 3)}`;
    lines.push(h ? `${days}: ${minutesToLabel(h.openMinute)} – ${minutesToLabel(h.closeMinute)}` : `${days}: closed`);
    runStart = weekday + 1;
  }
  return lines;
}

/** Opening hours as lines of text: once when every studio keeps the same hours, otherwise for each group of studios that do. */
export function openingHours(catalog: Pick<Catalog, "studios">): { studios: string; lines: string[] }[] {
  const groups = new Map<string, { names: string[]; lines: string[] }>();
  for (const studio of catalog.studios) {
    const lines = hoursLines(studio);
    const group = groups.get(lines.join("|")) ?? { names: [], lines };
    group.names.push(studio.name);
    groups.set(lines.join("|"), group);
  }
  return [...groups.values()].map((group) => ({ studios: groups.size === 1 ? "" : group.names.join(", "), lines: group.lines }));
}
