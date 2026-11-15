import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { loadDayAvailability, releaseExpiredHolds } from "@/server/availability";
import { loadCatalog } from "@/server/catalog";

/**
 * GET /api/availability?date=YYYY-MM-DD
 * Opening hours and taken time for every studio on one day. The browser turns
 * this into time slots with the shared functions in src/lib/domain. Read live
 * on every request; never cached.
 */
export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get("date") ?? "";
  const now = new Date();
  const db = await getDb();
  await releaseExpiredHolds(db, now);
  const catalog = await loadCatalog(db);
  const day = await loadDayAvailability(db, catalog, date, now);
  return Response.json(day, { headers: { "Cache-Control": "no-store" } });
}
