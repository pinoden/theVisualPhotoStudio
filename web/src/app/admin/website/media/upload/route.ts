import { revalidateTag } from "next/cache";
import { getDb } from "@/db/client";
import { formText } from "@/lib/parse";
import { CATALOG_TAG, WEBSITE_TAG } from "@/server/cached";
import { MEDIA_LIMITS, mayUseMediaLibrary, replaceImage, uploadImage } from "@/server/media";
import { getCurrentUser, sameSiteRequest } from "@/server/session";
import { readFormData } from "@/server/upload";

/**
 * POST /admin/website/media/upload: add one picture to the media library, or,
 * with `replace` (a picture's id), put a new file in that picture's place.
 * The uploader sends one file at a time and reads the answer, so this answers
 * in JSON and never redirects. The service checks what the viewer may do.
 */
const answer = (status: number, body: { ok: false; message: string } | { ok: true; id: string }) => Response.json(body, { status });

export async function POST(request: Request) {
  if (!sameSiteRequest(request)) return answer(403, { ok: false, message: "That did not come from this website." });
  const user = await getCurrentUser();
  if (!user) return answer(401, { ok: false, message: "Please sign in again." });
  // Refused before anything is read: a visitor who may not add pictures, and a file over the limit, which is stopped as
  // soon as it is, also when the client sends no length.
  const db = await getDb();
  if (!(await mayUseMediaLibrary(db, user))) return answer(403, { ok: false, message: "You cannot add pictures to the website." });
  const read = await readFormData(request, MEDIA_LIMITS.uploadBytes + 64 * 1024);
  if (!read.ok) {
    return read.problem === "too_large"
      ? answer(413, { ok: false, message: `That file is too large: ${Math.round(MEDIA_LIMITS.uploadBytes / 1024 / 1024)} MB at most.` })
      : answer(400, { ok: false, message: "The picture did not arrive whole. Please try again." });
  }
  const form = read.form;
  const file = form.get("file");
  if (!(file instanceof File)) return answer(400, { ok: false, message: "Choose a picture." });
  const input = { bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name };
  const replace = formText(form.get("replace"));
  const result = replace ? await replaceImage(db, user, replace, input, new Date()) : await uploadImage(db, user, input, new Date());
  if (!result.ok) return answer(422, result);
  if (replace) {
    // A replaced picture has a new address: the pages that show it must be made again, at once.
    revalidateTag(WEBSITE_TAG, { expire: 0 });
    revalidateTag(CATALOG_TAG, { expire: 0 });
  }
  return answer(200, { ok: true, id: result.picture.id });
}
