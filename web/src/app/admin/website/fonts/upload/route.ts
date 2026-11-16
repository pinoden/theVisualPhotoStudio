import { revalidateTag } from "next/cache";
import { getDb } from "@/db/client";
import { formText, intInRange } from "@/lib/parse";
import { WEBSITE_TAG } from "@/server/cached";
import { addFontFile, FONT_LIMITS } from "@/server/fonts";
import { getCurrentUser, sameSiteRequest } from "@/server/session";

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
  if (Number(request.headers.get("content-length") ?? 0) > FONT_LIMITS.fileBytes + 64 * 1024) {
    return back("error", `That file is too large for a font: ${Math.round(FONT_LIMITS.fileBytes / 1024 / 1024)} MB at most.`);
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back("error", "The file did not arrive whole. Please try again.");
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return back("error", "Choose a font file.");
  const weight = intInRange(formText(form.get("weight")), 100, 900);
  const heaviest = formText(form.get("weightMax"));
  const weightMax = heaviest === "" ? null : intInRange(heaviest, 100, 900);
  if (weight === null || (heaviest !== "" && weightMax === null)) return back("error", "Choose the weight the file holds.");
  const result = await addFontFile(
    await getDb(),
    user,
    formText(form.get("fontId")),
    { bytes: new Uint8Array(await file.arrayBuffer()), weight, weightMax, italic: form.get("italic") !== null },
    new Date(),
  );
  if (!result.ok) return back("error", result.message);
  revalidateTag(WEBSITE_TAG, { expire: 0 });
  return back("notice", "File added. The font can now be chosen in the design.");
}
