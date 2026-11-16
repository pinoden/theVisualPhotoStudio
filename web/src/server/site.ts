import { cache } from "react";
import { draftMode } from "next/headers";
import { getDb } from "@/db/client";
import { getPublishedDesign, getPublishedFrame, shownFrame, type ShownDesign, type ShownFrame } from "./cached";
import { loadCustomFonts } from "./fonts";
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
  return (await websiteAbilities(await getDb(), user)).editDesign;
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
