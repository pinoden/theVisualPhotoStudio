import { getDb } from "@/db/client";
import { readFontFile } from "@/server/fonts";

/**
 * GET /font-files/<id>/<name>: one file of a font the owners uploaded. The design
 * names it in the page's styles (`fontFaceCss`). A file never changes once
 * stored: a new file is a new id.
 */
export async function GET(_request: Request, context: RouteContext<"/font-files/[id]/[name]">) {
  const { id } = await context.params;
  const file = await readFontFile(await getDb(), id);
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(file.bytes), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(file.bytes.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
