import { and, eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { AccountFrame } from "@/components/AccountFrame";
import { AcceptedWords } from "@/components/AcceptedTerms";
import { getDb } from "@/db/client";
import { bookings } from "@/db/schema";
import { acceptedText } from "@/server/booking-forms";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "What You Agreed To", robots: { index: false, follow: false } };

export default function AcceptedPage(props: PageProps<"/account/appointments/[ref]/accepted/[id]">) {
  return (
    <>
      <div className="page-banner">
        <p className="section-eyebrow">My Account</p>
        <h1>What You Agreed To</h1>
      </div>
      <section className="section section-cream">
        <div className="container-sm">
          <Suspense fallback={<div className="spinner" />}>
            <Accepted params={props.params} />
          </Suspense>
        </div>
      </section>
    </>
  );
}

/**
 * The policies or an agreement as the signed-in client accepted them for one of their bookings (the November 20
 * brief: shown in the customer's own account). A booking of another address is not found.
 */
async function Accepted({ params }: Pick<PageProps<"/account/appointments/[ref]/accepted/[id]">, "params">) {
  await connection();
  const { ref, id } = await params;
  const user = await requireUser("/account/appointments");
  const db = await getDb();
  const [booking] = /^VS-[0-9A-Z]{6}$/.test(ref)
    ? await db
        .select({ id: bookings.id, ref: bookings.ref })
        .from(bookings)
        .where(and(eq(bookings.ref, ref), eq(bookings.customerEmail, user.email.trim().toLowerCase())))
        .limit(1)
    : [];
  const text = booking ? await acceptedText(db, booking.id, id, new Date()) : null;
  return (
    <AccountFrame user={user} active="/account/appointments">
      {text ? (
        <div className="admin-card">
          <h2>{text.title}</h2>
          <p>As you accepted it for booking {booking.ref}.</p>
          <AcceptedWords text={text} pdfHref={`/account/appointments/${booking.ref}/accepted/${text.id}/pdf`} />
        </div>
      ) : (
        <div className="admin-card">
          <p>This could not be found among your bookings.</p>
        </div>
      )}
      <p>
        <Link href={booking ? `/account/appointments#${booking.ref}` : "/account/appointments"}>Back to My Appointments</Link>
      </p>
    </AccountFrame>
  );
}
