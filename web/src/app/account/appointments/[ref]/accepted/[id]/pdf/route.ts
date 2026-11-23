import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { bookings } from "@/db/schema";
import { acceptedDownload } from "@/server/accepted-download";
import { getCurrentUser } from "@/server/session";

/** GET /account/appointments/<ref>/accepted/<id>/pdf: what the signed-in client accepted for one of their bookings, as a PDF. */
export async function GET(request: NextRequest, context: RouteContext<"/account/appointments/[ref]/accepted/[id]/pdf">) {
  const { ref, id } = await context.params;
  const user = await getCurrentUser();
  if (!user) {
    const signIn = new URL("/account/sign-in", request.url);
    signIn.searchParams.set("next", "/account/appointments");
    return Response.redirect(signIn, 303);
  }
  if (!/^VS-[0-9A-Z]{6}$/.test(ref)) return new Response("Not found", { status: 404 });
  const db = await getDb();
  const [booking] = await db
    .select({ id: bookings.id, ref: bookings.ref, customerName: bookings.customerName })
    .from(bookings)
    .where(and(eq(bookings.ref, ref), eq(bookings.customerEmail, user.email.trim().toLowerCase())))
    .limit(1);
  if (!booking) return new Response("Not found", { status: 404 });
  return acceptedDownload(db, booking, id, new Date());
}
