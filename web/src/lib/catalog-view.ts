import type { Catalog, CatalogStudio } from "@/server/catalog";
import { weekdayName, minutesToLabel } from "@/lib/domain/time";

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

/** "20% off when you book 2, 22% off when you book 3 or more"; empty when no discount is set. */
export function multiStudioOffer(catalog: Catalog): string {
  const discounts = Object.entries(catalog.settings.multiStudioPercent)
    .map(([count, percent]) => ({ count: Number(count), percent }))
    .filter((d) => d.percent > 0)
    .sort((a, b) => a.count - b.count);
  return discounts
    .map((d, index) => `${d.percent}% off when you book ${d.count}${index === discounts.length - 1 ? " or more" : ""}`)
    .join(", ");
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
