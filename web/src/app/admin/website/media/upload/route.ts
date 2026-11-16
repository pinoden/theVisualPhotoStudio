import { revalidateTag } from "next/cache";
import { getDb } from "@/db/client";
import { formText } from "@/lib/parse";
import { CATALOG_TAG, WEBSITE_TAG } from "@/server/cached";
import { MEDIA_LIMITS, replaceImage, uploadImage } from "@/server/media";
import { getCurrentUser, sameSiteRequest } from "@/server/session";

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
  // Refused before it is read: a file far over the limit is never taken into memory.
  if (Number(request.headers.get("content-length") ?? 0) > MEDIA_LIMITS.uploadBytes + 64 * 1024) {
    return answer(413, { ok: false, message: `That file is too large: ${Math.round(MEDIA_LIMITS.uploadBytes / 1024 / 1024)} MB at most.` });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return answer(400, { ok: false, message: "The picture did not arrive whole. Please try again." });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return answer(400, { ok: false, message: "Choose a picture." });
  const input = { bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name };
  const replace = formText(form.get("replace"));
  const db = await getDb();
  const result = replace ? await replaceImage(db, user, replace, input, new Date()) : await uploadImage(db, user, input, new Date());
  if (!result.ok) return answer(422, result);
  if (replace) {
    // A replaced picture has a new address: the pages that show it must be made again, at once.
    revalidateTag(WEBSITE_TAG, { expire: 0 });
    revalidateTag(CATALOG_TAG, { expire: 0 });
  }
  return answer(200, { ok: true, id: result.picture.id });
}
