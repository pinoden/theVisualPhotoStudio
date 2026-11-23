import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { isIsoDate } from "@/lib/domain/time";
import { propsFree } from "@/server/props";
import { localToUtc } from "@/server/tz";

/**
 * GET /api/props-free?date=YYYY-MM-DD&start=<minute>&duration=<minutes>
 * How many of each prop are free for a booking of that time, and which are away that day (src/server/props.ts), for
 * the booking page's add-ons.
 * The booking checks again when it is made. Read live; never cached.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const date = params.get("date") ?? "";
  const start = Number(params.get("start"));
  const duration = Number(params.get("duration"));
  if (!isIsoDate(date) || !Number.isInteger(start) || start < 0 || start >= 1440 || !Number.isInteger(duration) || duration <= 0 || duration > 1440) {
    return Response.json({ ok: false, message: "Choose a day, a time and a length." }, { status: 400 });
  }
  const { free, away } = await propsFree(await getDb(), localToUtc(date, start), localToUtc(date, start + duration));
  return Response.json({ ok: true, free, away }, { headers: { "Cache-Control": "no-store" } });
}
