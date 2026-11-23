import { getDb } from "@/db/client";
import { getCurrentUser, sameSiteRequest } from "@/server/session";
import { finishVideoUpload } from "@/server/videos";

/** POST /api/videos/<id>/finish: the browser's upload is done; the site checks it arrived whole (question 77). */
export async function POST(request: Request, context: RouteContext<"/api/videos/[id]/finish">) {
  if (!sameSiteRequest(request)) return Response.json({ ok: false, message: "That did not come from this website." }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, message: "Please sign in again." }, { status: 401 });
  const { id } = await context.params;
  const result = await finishVideoUpload(await getDb(), user, id);
  return Response.json(result, { status: result.ok ? 200 : 422 });
}
