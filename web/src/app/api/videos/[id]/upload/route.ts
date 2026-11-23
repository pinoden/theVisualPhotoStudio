import { getDb } from "@/db/client";
import { getCurrentUser, sameSiteRequest } from "@/server/session";
import { DATABASE_VIDEO_MAX_BYTES } from "@/server/video-store";
import { receiveDatabaseUpload } from "@/server/videos";

/**
 * PUT /api/videos/<id>/upload: the file of a video being uploaded, where none of Neon's storage is set up (a computer of
 * the builder's, the tests): kept in the database, small files only. On the host the browser sends it to Neon instead.
 */
export async function PUT(request: Request, context: RouteContext<"/api/videos/[id]/upload">) {
  if (!sameSiteRequest(request)) return Response.json({ ok: false, message: "That did not come from this website." }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, message: "Please sign in again." }, { status: 401 });
  const announced = Number(request.headers.get("content-length") ?? "0");
  if (announced > DATABASE_VIDEO_MAX_BYTES) return Response.json({ ok: false, message: "That video is too large." }, { status: 413 });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > DATABASE_VIDEO_MAX_BYTES) return Response.json({ ok: false, message: "That video is too large." }, { status: 413 });
  const { id } = await context.params;
  const result = await receiveDatabaseUpload(await getDb(), user, id, bytes);
  return Response.json(result, { status: result.ok ? 200 : 422 });
}
