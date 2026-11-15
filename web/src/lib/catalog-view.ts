import type { Catalog, CatalogStudio } from "@/server/catalog";
import { multiStudioPercentFor } from "@/lib/domain/pricing";
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
