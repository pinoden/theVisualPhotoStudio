import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { BookingSummary } from "@/components/BookingSummary";
import { ManageBooking } from "@/components/ManageBooking";
import { getDb } from "@/db/client";
import { telHref } from "@/lib/site/frame";
import { getBookingByToken, isUpcomingVisit } from "@/server/bookings";
import { getManageChoices, noticeBookingPayments } from "@/server/manage";
import { payLinkDeps } from "@/server/runtime";
import { loadAccessInstructions } from "@/server/settings";
import { siteFrame } from "@/server/site";

export const metadata: Metadata = {
  title: "Your Booking",
  // The address contains the customer's private link secret.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const HEADING: Record<string, { heading: string; icon: string }> = {
  confirmed: { heading: "Booking Confirmed", icon: "✓" },
  completed: { heading: "Booking Completed", icon: "✓" },
  cancelled: { heading: "Booking Cancelled", icon: "×" },
  no_show: { heading: "Booking Missed", icon: "×" },
  pending_payment: { heading: "Payment In Progress", icon: "…" },
  expired: { heading: "Booking Not Completed", icon: "×" },
};

export default function BookingPage(props: PageProps<"/booking/[ref]">) {
  return (
    <section className="section section-cream">
      <Suspense
        fallback={
          <div className="confirmation-card">
            <div className="spinner" />
          </div>
        }
      >
        <BookingDetails params={props.params} searchParams={props.searchParams} />
      </Suspense>
    </section>
  );
}

async function BookingDetails({ params, searchParams }: Pick<PageProps<"/booking/[ref]">, "params" | "searchParams">) {
  // Always rendered for the incoming request: a booking is private and live.
  await connection();
  const [{ ref }, query] = await Promise.all([params, searchParams]);
  const token = typeof query.t === "string" ? query.t : "";
  const db = await getDb();
  // A payment link paid that the site has not seen yet is recorded first: what the page says counts it.
  await noticeBookingPayments(db, ref, { kind: "token", token }, await payLinkDeps());
  const booking = await getBookingByToken(db, ref, token);
  const { business } = (await siteFrame()).frame;

  if (!booking) {
    return (
      <div className="confirmation-card">
        <h2>Booking not found</h2>
        <div className="divider" />
        <p>
          This link is not valid. Please use the link in your confirmation email, <Link href="/account">sign in</Link>{" "}
          to see your bookings, or call us at <a href={telHref(business.phone)}>{business.phone}</a>.
        </p>
        <Link href="/book" className="btn btn-dark mt-3">
          Book a Studio
        </Link>
      </div>
    );
  }

  const status =
    booking.status === "cancelled" && booking.cancelReason === "rescheduled"
      ? { heading: "Released for Rescheduling", icon: "↻" }
      : (HEADING[booking.status] ?? HEADING.confirmed);
  const now = new Date();
  const choices =
    booking.status === "confirmed" ? await getManageChoices(db, booking.ref, { kind: "token", token }, now) : null;
  // Only someone holding the private link of a confirmed booking that has not ended is told how to get in.
  const access = isUpcomingVisit(booking, now) ? await loadAccessInstructions(db) : "";

  return (
    <div className="confirmation-card" style={{ textAlign: "left" }}>
      <div style={{ textAlign: "center" }}>
        <div className="confirmation-icon">{status.icon}</div>
        <h2>{status.heading}</h2>
        <div className="booking-ref">{booking.ref}</div>
        <div className="divider" />
      </div>

      <BookingSummary booking={booking} />

      {booking.label === "reschedule_pending" && (
        <div className="notice" role="status">
          We have your request to move this booking. Your time is still held for you, and we will confirm the new
          date and time with you.
        </div>
      )}

      {booking.status === "confirmed" && (
        <>
          <p style={{ fontSize: ".9rem" }}>
            A confirmation email has been sent to <strong>{booking.customerEmail}</strong>. Times are Eastern Time.
          </p>
          <p style={{ fontSize: ".9rem" }}>
            {business.addressLine1}, {business.addressLine2}. Your booking begins at the scheduled start time; please
            arrive no more than five minutes early.
          </p>
          {access && (
            <div className="notice" style={{ whiteSpace: "pre-line" }}>
              <strong>Getting in</strong>
              <br />
              {access}
            </div>
          )}
        </>
      )}

      <ManageBooking bookingRef={booking.ref} token={token} choices={choices} />

      <div style={{ display: "flex", gap: "1rem", justifyContent: "center", marginTop: "2rem", flexWrap: "wrap" }}>
        <Link href="/" className="btn btn-outline">
          Back to Home
        </Link>
        <Link href="/book" className="btn btn-dark">
          Book Another
        </Link>
      </div>
    </div>
  );
}
