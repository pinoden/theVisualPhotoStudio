import { revalidateTag } from "next/cache";
import { getDb } from "@/db/client";
import { formText, intInRange } from "@/lib/parse";
import { WEBSITE_TAG } from "@/server/cached";
import { addFontFile, FONT_LIMITS, mayEditFonts } from "@/server/fonts";
import { getCurrentUser, sameSiteRequest } from "@/server/session";
import { readFormData } from "@/server/upload";

/**
 * POST /admin/website/fonts/upload: add one file to a font of the owners'
 * own. A plain form posts here, because a file can be larger than a server
 * action accepts; the answer sends the browser back to the fonts page with a
 * short message. The service checks what the viewer may do.
 */
const PAGE = "/admin/website/fonts";

const back = (kind: "notice" | "error", message: string) =>
  new Response(null, { status: 303, headers: { Location: `${PAGE}?${kind}=${encodeURIComponent(message)}` } });

export async function POST(request: Request) {
  if (!sameSiteRequest(request)) return new Response(null, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return new Response(null, { status: 303, headers: { Location: `/account/sign-in?next=${encodeURIComponent(PAGE)}` } });
  // Refused before anything is read: a visitor who may not add fonts, and a file over the limit, which is stopped as
  // soon as it is, also when the client sends no length.
  const db = await getDb();
  if (!(await mayEditFonts(db, user))) return new Response(null, { status: 403 });
  const read = await readFormData(request, FONT_LIMITS.fileBytes + 64 * 1024);
  if (!read.ok) {
    return read.problem === "too_large"
      ? back("error", `That file is too large for a font: ${Math.round(FONT_LIMITS.fileBytes / 1024 / 1024)} MB at most.`)
      : back("error", "The file did not arrive whole. Please try again.");
  }
  const form = read.form;
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return back("error", "Choose a font file.");
  const weight = intInRange(formText(form.get("weight")), 100, 900);
  const heaviest = formText(form.get("weightMax"));
  const weightMax = heaviest === "" ? null : intInRange(heaviest, 100, 900);
  if (weight === null || (heaviest !== "" && weightMax === null)) return back("error", "Choose the weight the file holds.");
  const result = await addFontFile(
    db,
    user,
    formText(form.get("fontId")),
    { bytes: new Uint8Array(await file.arrayBuffer()), weight, weightMax, italic: form.get("italic") !== null },
    new Date(),
  );
  if (!result.ok) return back("error", result.message);
  revalidateTag(WEBSITE_TAG, { expire: 0 });
  return back("notice", "File added. The font can now be chosen in the design.");
}
