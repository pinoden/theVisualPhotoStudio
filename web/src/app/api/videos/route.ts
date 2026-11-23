import { getDb } from "@/db/client";
import { getCurrentUser, sameSiteRequest } from "@/server/session";
import { startVideoUpload } from "@/server/videos";

/**
 * POST /api/videos: start an upload of a video to the media library (question 77 in ProjectLibrary.md), from its name,
 * type and size. Answers with where the browser sends the file. The service checks what the viewer may do.
 */
export async function POST(request: Request) {
  if (!sameSiteRequest(request)) return Response.json({ ok: false, message: "That did not come from this website." }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, message: "Please sign in again." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { filename?: unknown; contentType?: unknown; size?: unknown } | null;
  const result = await startVideoUpload(
    await getDb(),
    user,
    {
      filename: typeof body?.filename === "string" ? body.filename.slice(0, 200) : "video",
      contentType: typeof body?.contentType === "string" ? body.contentType : "",
      size: typeof body?.size === "number" ? body.size : 0,
    },
    new Date(),
  );
  return Response.json(result, { status: result.ok ? 200 : 422 });
}
