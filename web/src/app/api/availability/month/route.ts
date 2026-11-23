import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { releaseExpiredHolds } from "@/server/availability";
import { loadCatalog } from "@/server/catalog";
import { loadMonthFits } from "@/server/month-availability";

/**
 * GET /api/availability/month?month=YYYY-MM&studios=<id>,<id>&duration=<minutes>[&photography=1]
 * The days of a month on which a booking of these studios and this length fits, for the booking page's month
 * calendar (src/server/month-availability.ts). Read live on every request; never cached.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const now = new Date();
  const db = await getDb();
  await releaseExpiredHolds(db, now);
  const catalog = await loadCatalog(db);
  const result = await loadMonthFits(
    db,
    catalog,
    {
      month: params.get("month") ?? "",
      studioIds: (params.get("studios") ?? "").split(",").filter(Boolean).slice(0, 10),
      durationMinutes: Number(params.get("duration")),
      photography: params.get("photography") === "1",
    },
    now,
  );
  return Response.json(result, { status: result.ok ? 200 : 400, headers: { "Cache-Control": "no-store" } });
}
