import { cacheLife, cacheTag } from "next/cache";
import { getDb } from "@/db/client";
import { loadCatalog, type Catalog } from "./catalog";

export const CATALOG_TAG = "catalog";

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
