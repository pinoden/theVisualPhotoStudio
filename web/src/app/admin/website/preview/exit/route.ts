import { draftMode } from "next/headers";
import { redirect } from "next/navigation";
import { formText } from "@/lib/parse";
import { safeNextPath } from "@/server/session";

/**
 * POST /admin/website/preview/exit: leave the preview. The browser goes back
 * to the page it was on (`to`), which now shows what is published. Anyone can
 * call it: it only ever takes a preview away.
 */
export async function POST(request: Request) {
  // A request that is not a form (none of the site's own) still leaves the preview, and goes to the home page.
  const form = await request.formData().catch(() => null);
  const to = formText(form?.get("to") ?? null);
  (await draftMode()).disable();
  const path = safeNextPath(to);
  redirect(path === to ? path : "/");
}
