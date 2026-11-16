import { draftMode } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { getCurrentUser, safeNextPath } from "@/server/session";
import { websiteAbilities } from "@/server/website";

/**
 * GET /admin/website/preview?to=/rates: show the website with the changes
 * that are not published yet, starting at the page `to`. For someone who may
 * edit the website; anyone else gets "not found".
 *
 * It switches on Next.js Draft Mode for this browser, which is a cookie.
 * Every page then shows the drafts (src/server/site.ts) until the person
 * leaves the preview, signs out or closes the browser.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !(await websiteAbilities(await getDb(), user)).editDesign) return new Response("Not found", { status: 404 });
  const to = request.nextUrl.searchParams.get("to");
  // Only ever a page of this site.
  const path = safeNextPath(to ?? "/");
  (await draftMode()).enable();
  redirect(to === null || path !== to ? "/" : path);
}
