import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { acceptedDownload } from "@/server/accepted-download";
import { getBookingByToken } from "@/server/bookings";

/** GET /booking/<ref>/accepted/<id>/pdf?t=…: what the client accepted, as a PDF, with their booking's private link. */
export async function GET(request: NextRequest, context: RouteContext<"/booking/[ref]/accepted/[id]/pdf">) {
  const { ref, id } = await context.params;
  const db = await getDb();
  const booking = await getBookingByToken(db, ref, request.nextUrl.searchParams.get("t") ?? "");
  if (!booking) return new Response("Not found", { status: 404 });
  return acceptedDownload(db, booking, id, new Date());
}
