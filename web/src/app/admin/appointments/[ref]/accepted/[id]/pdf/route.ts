import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { bookings } from "@/db/schema";
import { acceptedDownload } from "@/server/accepted-download";
import { getAppointment } from "@/server/appointments";
import { getCurrentUser } from "@/server/session";

/**
 * GET /admin/appointments/<ref>/accepted/<id>/pdf: what an appointment's client accepted at checkout, as a PDF, for
 * whoever may see the appointment. Anyone else is answered as for an appointment that does not exist.
 */
export async function GET(request: NextRequest, context: RouteContext<"/admin/appointments/[ref]/accepted/[id]/pdf">) {
  const { ref, id } = await context.params;
  const user = await getCurrentUser();
  if (!user) {
    const signIn = new URL("/account/sign-in", request.url);
    signIn.searchParams.set("next", /^VS-[0-9A-Z]{6}$/.test(ref) ? `/admin/appointments/${ref}` : "/admin");
    return Response.redirect(signIn, 303);
  }
  if (!["staff", "manager", "owner"].includes(user.role)) return new Response("Not found", { status: 404 });
  const db = await getDb();
  const now = new Date();
  const appointment = await getAppointment(db, user, ref, now);
  if (!appointment) return new Response("Not found", { status: 404 });
  const [booking] = await db.select({ id: bookings.id, ref: bookings.ref, customerName: bookings.customerName }).from(bookings).where(eq(bookings.ref, appointment.ref)).limit(1);
  if (!booking) return new Response("Not found", { status: 404 });
  return acceptedDownload(db, booking, id, now);
}
