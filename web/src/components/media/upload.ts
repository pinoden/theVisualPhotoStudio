/**
 * Sending a picture to the media library from the browser.
 *
 * A photograph straight from a camera is many megabytes and far more pixels
 * than any screen shows. It is made smaller here, before it is sent, so an
 * upload takes seconds on a phone's connection and fits whatever limit a host
 * puts on the size of a request. The server prepares every picture again
 * whatever arrives (src/server/media.ts): this is only to save the wait.
 */

/** The longest side a picture needs: the same as the server keeps. */
const EDGE = 2560;
/** Below this a JPEG is sent as it is. */
const SMALL_ENOUGH = 1_500_000;

export const PICTURE_TYPES = "image/jpeg,image/png,image/webp,image/avif";

export type UploadAnswer = { ok: true; id: string } | { ok: false; message: string };

async function shrink(file: File): Promise<Blob> {
  // Only photographs: a PNG or WebP is usually a drawing or already made for the web.
  if (file.type !== "image/jpeg" || file.size < SMALL_ENOUGH) return file;
  try {
    const bitmap = await createImageBitmap(file); // turned the way the camera held it
    const scale = Math.min(1, EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const smaller = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    return smaller && smaller.size < file.size ? smaller : file;
  } catch {
    return file; // a browser that cannot do it sends the file as it is
  }
}

/** Add `file` to the library, or, with `replace` (a picture's id), put it in that picture's place. */
export async function uploadPicture(file: File, replace?: string): Promise<UploadAnswer> {
  const body = new FormData();
  body.append("file", await shrink(file), file.name);
  if (replace) body.append("replace", replace);
  try {
    const response = await fetch("/admin/website/media/upload", { method: "POST", body });
    const answer: unknown = await response.json();
    if (typeof answer === "object" && answer !== null && "ok" in answer) return answer as UploadAnswer;
    return { ok: false, message: "The picture was not accepted. Please try again." };
  } catch {
    return { ok: false, message: "The picture could not be sent. Check your connection and try again." };
  }
}
