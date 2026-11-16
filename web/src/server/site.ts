import type { Metadata } from "next";
import { cache } from "react";
import { draftMode } from "next/headers";
import { getDb } from "@/db/client";
import type { Picture } from "./media";
import { getCatalog, getPublishedDesign, getPublishedFrame, getPublishedPage, shownFrame, type ShownDesign, type ShownFrame } from "./cached";
import { configuredSiteUrl } from "./runtime";
import { loadCustomFonts } from "./fonts";
import { loadPagePreview, type ShownPage } from "./pages";
import { getCurrentUser } from "./session";
import { DESIGN_DOC, FRAME_DOC, loadDraftOrPublished, websiteAbilities } from "./website";

/**
 * What the website shows for this request: what is published, or, in a
 * preview, the drafts.
 *
 * A preview is Next.js Draft Mode, switched on by `/admin/website/preview`
 * for someone who may edit the website. While it is on, that browser sees
 * every page with the unpublished changes in place; everyone else keeps
 * seeing the published site, from the cache. The cookie that marks a preview
 * is not enough on its own: the person must still be signed in and still be
 * allowed to edit, so a preview ends with the session.
 *
 * Pages and the root layout call `siteDesign()` and `siteFrame()`, never the
 * cached functions directly.
 */

/** True when this request is a preview of unpublished changes. Asked once per request. */
export const isPreview = cache(async (): Promise<boolean> => {
  const { isEnabled } = await draftMode();
  if (!isEnabled) return false;
  const user = await getCurrentUser();
  if (!user) return false;
  const may = await websiteAbilities(await getDb(), user);
  return may.editDesign || may.editPages;
});

export async function siteDesign(): Promise<ShownDesign> {
  if (!(await isPreview())) return getPublishedDesign();
  const db = await getDb();
  return { design: await loadDraftOrPublished(db, DESIGN_DOC), fonts: await loadCustomFonts(db) };
}

export async function siteFrame(): Promise<ShownFrame> {
  if (!(await isPreview())) return getPublishedFrame();
  const db = await getDb();
  return shownFrame(db, await loadDraftOrPublished(db, FRAME_DOC));
}

/** The picture a link to the website shows when shared: the one the owners chose, else the first studio's first photo. */
export async function sharePicture(): Promise<Picture | null> {
  const [{ share }, catalog] = await Promise.all([siteFrame(), getCatalog()]);
  return share ?? catalog.studios.find((studio) => studio.photos.length > 0)?.photos[0] ?? null;
}

/**
 * What a page says about itself when a link to it is shared (Open Graph, and
 * the same for X): its title and description, its address and the sharing
 * picture. The addresses are made whole with `SITE_URL` (`metadataBase` in
 * the root layout).
 */
export async function shareMetadata(input: {
  title: string;
  description: string;
  /** The page's own address: given, it is the page's canonical address too. The root layout gives none, for the pages that say nothing of their own. */
  path?: string;
}): Promise<Pick<Metadata, "openGraph" | "twitter" | "alternates">> {
  const [{ frame }, picture] = await Promise.all([siteFrame(), sharePicture()]);
  const images = picture ? [{ url: picture.url, width: picture.width, height: picture.height, alt: picture.alt }] : [];
  const here = input.path === undefined ? {} : { url: input.path };
  return {
    ...(input.path === undefined ? {} : { alternates: { canonical: input.path } }),
    openGraph: { type: "website", locale: "en_US", siteName: frame.business.name, title: input.title, description: input.description, ...here, images },
    twitter: { card: picture ? "summary_large_image" : "summary", title: input.title, description: input.description, images: images.map((image) => image.url) },
  };
}

/** The website's address for metadata: `SITE_URL`, which a prerendered page can read. */
export function metadataBase(): URL | undefined {
  const url = configuredSiteUrl();
  return url ? new URL(url) : undefined;
}

/** The page at an address, as this request shows it: what is published, or in a preview its draft. Null when there is none. */
export async function sitePage(slug: string): Promise<ShownPage | null> {
  if (!(await isPreview())) return getPublishedPage(slug);
  return loadPagePreview(await getDb(), slug, new Date());
}
