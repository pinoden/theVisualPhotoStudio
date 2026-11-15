import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { taskDeps } from "@/server/runtime";
import { runScheduledTasks } from "@/server/tasks";

/**
 * GET /api/cron/tick: the recurring jobs (complete visits and send loyalty
 * codes, retry refunds, deliver queued email, release abandoned holds).
 * A scheduler should call it every few minutes with
 * `Authorization: Bearer <CRON_SECRET>`.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = Buffer.from(request.headers.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${secret}`);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return Response.json({ ok: false }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    // Without a secret anyone could trigger the jobs; refuse rather than run open.
    return Response.json({ ok: false, message: "CRON_SECRET is not set." }, { status: 503 });
  }

  const summary = await runScheduledTasks(await getDb(), await taskDeps());
  return Response.json({ ok: true, ...summary }, { headers: { "Cache-Control": "no-store" } });
}
