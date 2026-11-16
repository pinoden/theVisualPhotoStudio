import { cacheLife, cacheTag } from "next/cache";
import { getDb } from "@/db/client";
import type { Design } from "@/lib/site/design";
import { announcementShows, type SiteFrame } from "@/lib/site/frame";
import { loadCatalog, type Catalog } from "./catalog";
import { localDateOf } from "./tz";
import { DESIGN_DOC, FRAME_DOC, loadPublished } from "./website";

export const CATALOG_TAG = "catalog";
/** Everything published under Admin, Website. Publishing calls `updateTag(WEBSITE_TAG)`. */
export const WEBSITE_TAG = "website";

/**
 * The public catalog (studios, hours, prices, add-ons, settings), cached so
 * pages can be prerendered. Anything that edits catalog data must call
 * `updateTag(CATALOG_TAG)`. Never use this for bookings or availability.
 */
export async function getCatalog(): Promise<Catalog> {
  "use cache";
  cacheTag(CATALOG_TAG);
  cacheLife("minutes");
  const db = await getDb();
  return loadCatalog(db);
}

/** The design the public sees. For a page, use `siteDesign()` in src/server/site.ts, which also knows about previews. */
export async function getPublishedDesign(): Promise<Design> {
  "use cache";
  cacheTag(WEBSITE_TAG);
  cacheLife("minutes");
  return loadPublished(await getDb(), DESIGN_DOC);
}

/** The frame around every page, and whether its announcement shows today. */
export interface ShownFrame {
  frame: SiteFrame;
  /** The announcement is switched on, has text, and today is inside its dates. */
  announcement: boolean;
}

/**
 * The published header, menu and footer. Whether the announcement shows is
 * worked out here, from the studio's date: the answer is cached with the rest
 * and worked out again every few minutes, so a bar with dates appears and
 * goes without anyone publishing anything.
 */
export async function getPublishedFrame(): Promise<ShownFrame> {
  "use cache";
  cacheTag(WEBSITE_TAG);
  cacheLife("minutes");
  const frame = await loadPublished(await getDb(), FRAME_DOC);
  return { frame, announcement: announcementShows(frame, localDateOf(new Date())) };
}
