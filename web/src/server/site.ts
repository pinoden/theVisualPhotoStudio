import type { Metadata } from "next";
import { cache } from "react";
import { draftMode, headers } from "next/headers";
import { connection } from "next/server";
import { getDb } from "@/db/client";
import { isCheckScope, WEBSITE_CHECK_HEADER, type CheckScope } from "@/lib/site/website-check";
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
  // A preview is drawn when it is asked for. A production build also prefetches each linked page with the visitor's
  // cookies (Partial Prefetching), and in Draft Mode nothing it would draw is kept: without this, every such prefetch
  // in a preview read the clock for the session (`new Date()` while prerendering) and missed its caches, which
  // Next.js logs as errors (the browser tests against a production build, 2026-11-20).
  await connection();
  const user = await getCurrentUser();
  if (!user) return false;
  const may = await websiteAbilities(await getDb(), user);
  return may.editDesign || may.editPages;
});

/**
 * In a preview made for the editor's phone check, the one document whose
 * draft shows (src/lib/site/website-check.ts); null in an ordinary preview,
 * which shows every draft. Asked only in a preview: anywhere else the
 * request stays as static as it was.
 */
const checkScope = cache(async (): Promise<CheckScope | null> => {
  const value = (await headers()).get(WEBSITE_CHECK_HEADER);
  return isCheckScope(value) ? value : null;
});

/** Whether this request shows the draft of `what`: in a preview, unless it is the phone check of something else. */
async function showsDraftOf(what: "design" | "frame" | "pages"): Promise<boolean> {
  if (!(await isPreview())) return false;
  const scope = await checkScope();
  return scope === null || scope === what;
}

export async function siteDesign(): Promise<ShownDesign> {
  if (!(await showsDraftOf("design"))) return getPublishedDesign();
  const db = await getDb();
  return { design: await loadDraftOrPublished(db, DESIGN_DOC), fonts: await loadCustomFonts(db) };
}

export async function siteFrame(): Promise<ShownFrame> {
  if (!(await showsDraftOf("frame"))) return getPublishedFrame();
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
  // The page editor's check draws its page's draft by itself; every other check shows the pages as published.
  if (!(await showsDraftOf("pages"))) return getPublishedPage(slug);
  return loadPagePreview(await getDb(), slug, new Date());
}
