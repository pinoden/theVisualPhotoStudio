import { asc, eq } from "drizzle-orm";
import { addons, priceRules, specialDates, studioHours, studios } from "@/db/schema";
import type { DbLike } from "@/db/client";
import type { AddonKind } from "@/lib/addon-kinds";
import type { AddonDef, PriceRule } from "@/lib/domain/pricing";
import { defaultDayType, type DayType, type IsoDate } from "@/lib/domain/time";
import { loadAccessInstructions, loadSettings, type Settings } from "./settings";

export interface CatalogStudio {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  includedGuests: number;
  bufferMinutes: number;
  /** Its colour in the admin calendar. */
  color: string;
  /** weekday (1-7) -> opening hours; a missing weekday means closed. */
  hours: Record<number, { openMinute: number; closeMinute: number }>;
}

export interface CatalogAddon extends AddonDef {
  slug: string;
  description: string;
  /** What it is for: see ADDON_KINDS. */
  kind: AddonKind;
}

/** Everything public about what can be booked. Safe to send to the browser. */
export interface Catalog {
  studios: CatalogStudio[];
  rules: PriceRule[];
  addons: CatalogAddon[];
  settings: Settings;
  /** date -> day type, for dates priced differently from their weekday. */
  specialDates: Record<IsoDate, DayType>;
  /**
   * True when the owner has set how to get into the building. Only this fact
   * is public: the text itself (it can hold the door code) never enters the catalog.
   */
  accessInfoSent: boolean;
}

export async function loadCatalog(db: DbLike): Promise<Catalog> {
  const [studioRows, hourRows, ruleRows, addonRows, specialRows, settings, access] = await Promise.all([
    db.select().from(studios).where(eq(studios.active, true)).orderBy(asc(studios.sortOrder), asc(studios.name)),
    db.select().from(studioHours),
    db.select().from(priceRules),
    db.select().from(addons).where(eq(addons.active, true)).orderBy(asc(addons.sortOrder), asc(addons.name)),
    db.select().from(specialDates),
    loadSettings(db),
    loadAccessInstructions(db),
  ]);

  const activeIds = new Set(studioRows.map((s) => s.id));
  return {
    studios: studioRows.map((s) => ({
      id: s.id,
      slug: s.slug,
      name: s.name,
      tagline: s.tagline,
      description: s.description,
      includedGuests: s.includedGuests,
      bufferMinutes: s.bufferMinutes,
      color: s.color,
      hours: Object.fromEntries(
        hourRows
          .filter((h) => h.studioId === s.id)
          .map((h) => [h.weekday, { openMinute: h.openMinute, closeMinute: h.closeMinute }]),
      ),
    })),
    rules: ruleRows
      .filter((r) => activeIds.has(r.studioId))
      .map((r) => ({
        studioId: r.studioId,
        dayType: r.dayType,
        durationMinutes: r.durationMinutes,
        priceCents: r.priceCents,
      })),
    addons: addonRows
      .filter((a) => a.studioId === null || activeIds.has(a.studioId))
      .map((a) => ({
        id: a.id,
        slug: a.slug,
        name: a.name,
        description: a.description,
        priceCents: a.priceCents,
        studioId: a.studioId,
        maxQuantity: a.maxQuantity,
        kind: a.kind,
      })),
    settings,
    specialDates: Object.fromEntries(specialRows.map((r) => [r.day, r.dayType])),
    accessInfoSent: access !== "",
  };
}

export function dayTypeFor(catalog: Pick<Catalog, "specialDates">, date: IsoDate): DayType {
  return catalog.specialDates[date] ?? defaultDayType(date);
}
