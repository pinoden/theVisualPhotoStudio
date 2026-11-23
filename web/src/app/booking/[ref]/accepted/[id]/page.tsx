import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { AcceptedWords } from "@/components/AcceptedTerms";
import { getDb } from "@/db/client";
import { acceptedText } from "@/server/booking-forms";
import { getBookingByToken } from "@/server/bookings";

export const metadata: Metadata = {
  title: "What You Agreed To",
  // The address contains the customer's private link secret.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function AcceptedPage(props: PageProps<"/booking/[ref]/accepted/[id]">) {
  return (
    <section className="section section-cream">
      <Suspense
        fallback={
          <div className="confirmation-card">
            <div className="spinner" />
          </div>
        }
      >
        <Accepted params={props.params} searchParams={props.searchParams} />
      </Suspense>
    </section>
  );
}

/**
 * The policies or an agreement as the client accepted them at checkout, from their booking's private link (the
 * November 20 brief: shown in the customer's own account). The same link's key opens it as opens the booking.
 */
async function Accepted({ params, searchParams }: Pick<PageProps<"/booking/[ref]/accepted/[id]">, "params" | "searchParams">) {
  await connection();
  const [{ ref, id }, query] = await Promise.all([params, searchParams]);
  const token = typeof query.t === "string" ? query.t : "";
  const db = await getDb();
  const booking = await getBookingByToken(db, ref, token);
  const text = booking ? await acceptedText(db, booking.id, id, new Date()) : null;
  const back = booking ? `/booking/${booking.ref}?t=${encodeURIComponent(token)}` : "/account";
  return (
    <div className="container-sm accepted-page">
      {text ? (
        <>
          <h1>{text.title}</h1>
          <p>As you accepted it for booking {booking!.ref}.</p>
          <AcceptedWords text={text} pdfHref={`/booking/${booking!.ref}/accepted/${text.id}/pdf?t=${encodeURIComponent(token)}`} />
        </>
      ) : (
        <>
          <h1>Not found</h1>
          <p>This link is not valid. Please use the link in your confirmation email, or sign in to see your bookings.</p>
        </>
      )}
      <p>
        <Link href={back}>{booking ? "Back to your booking" : "Your account"}</Link>
      </p>
    </div>
  );
}
