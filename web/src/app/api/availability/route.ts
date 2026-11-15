import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { loadDayAvailability, releaseExpiredHolds } from "@/server/availability";
import { loadCatalog } from "@/server/catalog";

/**
 * GET /api/availability?date=YYYY-MM-DD[&photography=1]
 * Opening hours and taken time for every studio on one day, and with
 * `photography=1` the photographer's working hours and taken time as well. The browser turns
 * this into time slots with the shared functions in src/lib/domain. Read live
 * on every request; never cached.
 */
export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get("date") ?? "";
  const now = new Date();
  const db = await getDb();
  await releaseExpiredHolds(db, now);
  const catalog = await loadCatalog(db);
  const withPhotographer = request.nextUrl.searchParams.get("photography") === "1";
  const day = await loadDayAvailability(db, catalog, date, now, { withPhotographer });
  return Response.json(day, { headers: { "Cache-Control": "no-store" } });
}
