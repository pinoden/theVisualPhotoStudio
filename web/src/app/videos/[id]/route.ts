import { getDb } from "@/db/client";
import { videoForPlayer } from "@/server/videos";

/**
 * GET /videos/<id>: a video of the media library, for a page's player (question 77 in ProjectLibrary.md). On the host it
 * leads to the file in Neon's storage, which the player then reads by parts; where the site keeps the file itself, it is
 * served here, by parts too.
 */
export async function GET(request: Request, context: RouteContext<"/videos/[id]">) {
  const { id } = await context.params;
  const found = await videoForPlayer(await getDb(), id);
  if (!found) return new Response("Not found", { status: 404 });
  // Not kept by a cache: a video deleted, or one not ready yet, is answered as it is now.
  if ("redirect" in found) return new Response(null, { status: 302, headers: { Location: found.redirect, "Cache-Control": "no-store" } });

  const total = found.bytes.byteLength;
  const headers = {
    "Content-Type": found.contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (range && (range[1] !== "" || range[2] !== "")) {
    const start = range[1] === "" ? Math.max(0, total - Number(range[2])) : Number(range[1]);
    const end = range[1] === "" || range[2] === "" ? total - 1 : Math.min(Number(range[2]), total - 1);
    if (start > end || start >= total) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${total}` } });
    return new Response(Buffer.from(found.bytes.subarray(start, end + 1)), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": String(end - start + 1) },
    });
  }
  return new Response(Buffer.from(found.bytes), { headers: { ...headers, "Content-Length": String(total) } });
}
