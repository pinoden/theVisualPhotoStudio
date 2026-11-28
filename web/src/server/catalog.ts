import { asc, desc, eq } from "drizzle-orm";
import type { Service } from "@/lib/domain/services";
import { addons, bundlePrices, membershipPlans, membershipPlanStudios, photoPackages, photographers, priceRules, sales, specialDates, studioHours, studios } from "@/db/schema";
import { together, type DbLike } from "@/db/client";
import type { AddonKind } from "@/lib/addon-kinds";
import { bundlePricesWithBetween, rulesWithBetween, type AddonDef, type BundlePrice, type PriceRule } from "@/lib/domain/pricing";
import type { Sale } from "@/lib/domain/sale";
import { addDays, defaultDayType, type DayType, type IsoDate } from "@/lib/domain/time";
import { parseStudioFacts, type StudioFacts } from "@/lib/studio-facts";
import { loadPictures, type Picture } from "./media";
import { loadAccessInstructions, loadSettings, type Settings } from "./settings";
import { loadStudioPhotos } from "./studio-photos";

export interface CatalogStudio {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  includedGuests: number;
  /** Guests that can come beyond those included, each an extra guest. */
  extraGuests: number;
  bufferMinutes: number;
  /** Its colour in the admin calendar. */
  color: string;
  /** weekday (1-7) -> opening hours; a missing weekday means closed. */
  hours: Record<number, { openMinute: number; closeMinute: number }>;
  /** Its photos from the media library, in the owners' order. Empty until they add some: a tinted box stands in. */
  photos: Picture[];
  /** Its size, ceiling, light, cyclorama and what comes with it, as the owners wrote them: empty ones are not shown. */
  facts: StudioFacts;
  /** The picture of its floor plan, when the owners chose one that is in the library. */
  floorPlan: Picture | null;
}

export interface CatalogAddon extends AddonDef {
  slug: string;
  description: string;
  /** What it is for: see ADDON_KINDS. */
  kind: AddonKind;
  /** Its picture, when the owners chose one that is in the library (Props & Resources). */
  picture: Picture | null;
}

/** A session on sale, photography's or content creation's: one studio, one length, one price that includes the studio. */
export interface CatalogPhotoPackage {
  id: string;
  /** Whose session it is (question 69). */
  service: Service;
  studioId: string;
  durationMinutes: number;
  priceCents: number;
  /** What it includes, as the customer reads it. */
  includes: string;
}

/** A membership on sale (follow-up 3): studio minutes each month in its studios, for a monthly price. */
export interface CatalogMembershipPlan {
  id: string;
  name: string;
  description: string;
  minutes: number;
  priceCents: number;
  /** One studio, or the studios of a bundle, in the studios' order. */
  studioIds: string[];
}

/** Everything public about what can be booked. Safe to send to the browser. */
export interface Catalog {
  studios: CatalogStudio[];
  /** The studios' prices, and with them the lengths between the listed ones the owners sell (`between`). */
  rules: PriceRule[];
  /** The prices of studios booked together, likewise: each bundle whose every studio is open. */
  bundlePrices: BundlePrice[];
  addons: CatalogAddon[];
  settings: Settings;
  /** date -> day type, for dates priced differently from their weekday. */
  specialDates: Record<IsoDate, DayType>;
  /** The sessions on sale, photography's and content creation's. A service's are left out while nobody gives them. */
  photoPackages: CatalogPhotoPackage[];
  /**
   * True when the owner has set how to get into the building. Only this fact
   * is public: the text itself (it can hold the door code) never enters the catalog.
   */
  accessInfoSent: boolean;
  /** The memberships on sale, in the owners' order: plans that are offered, all of whose studios are open. */
  membershipPlans: CatalogMembershipPlan[];
  /**
   * The owners' sales (src/lib/domain/sale.ts), the one that ends last first. Read from the database: every one, since
   * pricing reads their dates against its own clock. Handed to a page: those that can be booked today or within a day
   * of it (`salesAround`), so that a sale to come is not told before its day.
   */
  sales: Sale[];
}

export async function loadCatalog(db: DbLike): Promise<Catalog> {
  const [studioRows, hourRows, ruleRows, addonRows, specialRows, settings, access, packageRows, photographerRows, photos, planRows, planStudioRows, bundleRows, saleRows] = await together(db, [
    () => db.select().from(studios).where(eq(studios.active, true)).orderBy(asc(studios.sortOrder), asc(studios.name)),
    () => db.select().from(studioHours),
    () => db.select().from(priceRules),
    () => db.select().from(addons).where(eq(addons.active, true)).orderBy(asc(addons.sortOrder), asc(addons.name)),
    () => db.select().from(specialDates),
    () => loadSettings(db),
    () => loadAccessInstructions(db),
    () => db.select().from(photoPackages).where(eq(photoPackages.active, true)).orderBy(asc(photoPackages.durationMinutes)),
    () => db.select({ service: photographers.service }).from(photographers).where(eq(photographers.active, true)),
    () => loadStudioPhotos(db),
    () => db.select().from(membershipPlans).where(eq(membershipPlans.active, true)).orderBy(asc(membershipPlans.sortOrder), asc(membershipPlans.createdAt)),
    () => db.select().from(membershipPlanStudios),
    () => db.select().from(bundlePrices),
    () => db.select().from(sales).orderBy(desc(sales.bookUntil), desc(sales.createdAt)).limit(200),
  ]);

  const activeIds = new Set(studioRows.map((s) => s.id));
  const facts = new Map(studioRows.map((s) => [s.id, parseStudioFacts(s.facts)]));
  const plans = [...facts.values()].map((entry) => entry.floorPlan).filter((id) => id !== "");
  // The floor plans' pictures and the add-ons', read together.
  const pictureIds = [...plans, ...addonRows.flatMap((a) => (a.mediaId ? [a.mediaId] : []))];
  const planPictures = pictureIds.length > 0 ? await loadPictures(db, pictureIds) : new Map<string, Picture>();
  return {
    studios: studioRows.map((s) => ({
      id: s.id,
      slug: s.slug,
      name: s.name,
      tagline: s.tagline,
      description: s.description,
      includedGuests: s.includedGuests,
      extraGuests: s.extraGuests,
      bufferMinutes: s.bufferMinutes,
      color: s.color,
      hours: Object.fromEntries(
        hourRows
          .filter((h) => h.studioId === s.id)
          .map((h) => [h.weekday, { openMinute: h.openMinute, closeMinute: h.closeMinute }]),
      ),
      photos: photos.get(s.id) ?? [],
      facts: facts.get(s.id)!,
      floorPlan: planPictures.get(facts.get(s.id)!.floorPlan) ?? null,
    })),
    rules: rulesWithBetween(
      ruleRows
        .filter((r) => activeIds.has(r.studioId))
        .map((r) => ({
          studioId: r.studioId,
          dayType: r.dayType,
          durationMinutes: r.durationMinutes,
          priceCents: r.priceCents,
        })),
      settings.betweenLengthsMinutes,
      settings.longestBookingMinutes,
    ),
    bundlePrices: bundlePricesWithBetween(
      bundleRows
        .map((row) => ({ key: row.studioKey.split("+"), row }))
        .filter(({ key }) => key.length > 1 && key.every((id) => activeIds.has(id)))
        // The studios in the site's order, as everything that names a bundle lists them.
        .map(({ key, row }) => ({ studioIds: studioRows.filter((s) => key.includes(s.id)).map((s) => s.id), durationMinutes: row.durationMinutes, priceCents: row.priceCents })),
      settings.betweenLengthsMinutes,
      settings.longestBookingMinutes,
    ),
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
        picture: (a.mediaId && planPictures.get(a.mediaId)) || null,
      })),
    settings,
    specialDates: Object.fromEntries(specialRows.map((r) => [r.day, r.dayType])),
    // A service's sessions are on sale while it has someone to give them (question 69).
    photoPackages: packageRows
      .filter((row) => activeIds.has(row.studioId) && photographerRows.some((person) => person.service === row.service))
      .map((row) => ({
        id: row.id,
        service: row.service,
        studioId: row.studioId,
        durationMinutes: row.durationMinutes,
        priceCents: row.priceCents,
        includes: row.includes,
      })),
    accessInfoSent: access !== "",
    membershipPlans: planRows
      .map((plan) => ({
        id: plan.id,
        name: plan.name,
        description: plan.description,
        minutes: plan.minutes,
        priceCents: plan.priceCents,
        studioIds: studioRows.filter((studio) => planStudioRows.some((link) => link.planId === plan.id && link.studioId === studio.id)).map((studio) => studio.id),
      }))
      .filter((plan) => plan.studioIds.length > 0 && plan.studioIds.length === planStudioRows.filter((link) => link.planId === plan.id).length),
    sales: saleRows.map((row) => ({
      id: row.id,
      name: row.name,
      percent: row.percent,
      studioIds: row.studioIds,
      bookFrom: row.bookFrom,
      bookUntil: row.bookUntil,
      visitFrom: row.visitFrom,
      visitUntil: row.visitUntil,
    })),
  };
}

/**
 * A catalog as a page is handed it: with the sales that can be booked on `today` or within a day of it. A page is
 * drawn a few minutes before it is read, and the device that reads it has its own clock, so the day before and the
 * day after come too; the booking screen and the price lists then keep to the studio's day.
 */
export function salesAround<T extends Pick<Catalog, "sales">>(catalog: T, today: IsoDate): T {
  return { ...catalog, sales: catalog.sales.filter((sale) => sale.bookFrom <= addDays(today, 1) && sale.bookUntil >= addDays(today, -1)) };
}

export function dayTypeFor(catalog: Pick<Catalog, "specialDates">, date: IsoDate): DayType {
  return catalog.specialDates[date] ?? defaultDayType(date);
}
