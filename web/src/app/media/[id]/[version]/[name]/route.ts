import { getDb } from "@/db/client";
import { readMediaFile } from "@/server/media";

/**
 * GET /media/<id>/<version>/<name>: a picture of the media library, as it is
 * stored. Pages do not usually ask for it themselves: they show pictures
 * through the framework's image handling, which fetches this address and
 * serves each visitor a size and a format that suit their screen.
 *
 * The version in the address goes up when a picture's file is replaced, so
 * an address names one file for good and can be kept by every cache for a
 * year. An address with an old version still answers, with the file there is
 * now and a short life, for the minute a cached page may still name it.
 */
export async function GET(_request: Request, context: RouteContext<"/media/[id]/[version]/[name]">) {
  const { id, version } = await context.params;
  const file = await readMediaFile(await getDb(), id);
  if (!file) return new Response("Not found", { status: 404 });
  const current = String(file.version) === version;
  return new Response(Buffer.from(file.bytes), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(file.bytes.byteLength),
      "Cache-Control": current ? "public, max-age=31536000, immutable" : "public, max-age=60",
      // Only ever shown as a picture: a browser must not guess another kind of file into it.
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
