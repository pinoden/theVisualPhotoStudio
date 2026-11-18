import type { Catalog, CatalogStudio } from "@/server/catalog";
import { multiStudioPercentFor } from "@/lib/domain/pricing";
import { weekdayName, minutesToLabel } from "@/lib/domain/time";

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
export function hourlyFromCents(catalog: Catalog, studioId: string): number | null {
  const prices = catalog.rules
    .filter((r) => r.studioId === studioId && r.durationMinutes === 60)
    .map((r) => r.priceCents);
  return prices.length > 0 ? Math.min(...prices) : null;
}

/** Price rows for a studio: one per duration, with weekday and weekend prices. */
export function priceTable(
  catalog: Catalog,
  studioId: string,
): { durationMinutes: number; weekdayCents: number | null; weekendCents: number | null }[] {
  const rules = catalog.rules.filter((r) => r.studioId === studioId);
  const durations = [...new Set(rules.map((r) => r.durationMinutes))].sort((a, b) => a - b);
  return durations.map((durationMinutes) => ({
    durationMinutes,
    weekdayCents: rules.find((r) => r.durationMinutes === durationMinutes && r.dayType === "weekday")?.priceCents ?? null,
    weekendCents: rules.find((r) => r.durationMinutes === durationMinutes && r.dayType === "weekend")?.priceCents ?? null,
  }));
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
export function multiStudioOffer(catalog: Pick<Catalog, "settings">): string {
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
