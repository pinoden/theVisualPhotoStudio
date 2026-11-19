import { connection } from "next/server";
import { getDb } from "@/db/client";
import { checkHealth } from "@/server/heartbeat";

/**
 * GET /api/health: for an uptime monitor. 200 when the database answers and,
 * in production, the scheduler ran in the last 15 minutes; 503 otherwise,
 * with what is wrong. No secrets: only whether each part works, and when the
 * scheduler last ran.
 */
export async function GET() {
  await connection(); // checked at request time, never at build time
  let health;
  try {
    health = await checkHealth(await getDb(), new Date(), process.env.NODE_ENV === "production");
  } catch {
    // The database could not even be opened.
    health = { ok: false, database: "unreachable" as const, scheduler: null };
  }
  return Response.json(health, { status: health.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
