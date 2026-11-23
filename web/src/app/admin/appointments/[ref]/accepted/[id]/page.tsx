import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AcceptedWords } from "@/components/AcceptedTerms";
import { getDb } from "@/db/client";
import { bookings } from "@/db/schema";
import { getAppointment } from "@/server/appointments";
import { acceptedText } from "@/server/booking-forms";
import { requireStaff } from "@/server/session";
import { AdminFrame, AdminLoading } from "../../../../frame";

export const metadata: Metadata = { title: "Accepted at checkout", robots: { index: false } };

export default function AcceptedPage(props: PageProps<"/admin/appointments/[ref]/accepted/[id]">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Accepted params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

/**
 * The policies or an agreement as an appointment's client accepted them at checkout (the owner's admin brief of
 * 2026-11-22, item 8): the Policies page's very words since 2026-11-23, or an agreement's version. For whoever may see
 * the appointment.
 */
async function Accepted({ params, searchParams }: Pick<PageProps<"/admin/appointments/[ref]/accepted/[id]">, "params" | "searchParams">) {
  await connection();
  const { ref, id } = await params;
  const page = `/admin/appointments/${encodeURIComponent(ref)}`;
  const viewer = await requireStaff(`${page}/accepted/${encodeURIComponent(id)}`);
  const db = await getDb();
  const now = new Date();
  const appointment = await getAppointment(db, viewer, ref, now);
  if (!appointment) notFound();
  const [booking] = await db.select({ id: bookings.id }).from(bookings).where(eq(bookings.ref, appointment.ref)).limit(1);
  const text = booking ? await acceptedText(db, booking.id, id, now) : null;
  if (!text) notFound();
  return (
    <AdminFrame active="/admin/calendar" title={text.title} query={await searchParams} viewer={viewer}>
      <div className="admin-card">
        <p>
          As {appointment.customerName} accepted it for {appointment.ref}.
        </p>
        <AcceptedWords text={text} />
        <p>
          <Link href={page}>Back to the appointment</Link>
        </p>
      </div>
    </AdminFrame>
  );
}
