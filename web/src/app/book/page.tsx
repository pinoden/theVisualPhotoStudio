import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BookingFlow } from "@/components/BookingFlow";
import { CodeBalanceCheck } from "@/components/CodeBalanceCheck";
import { getCatalog } from "@/server/cached";
import { checkoutPolicies } from "./checkout-policies";
import { shareMetadata } from "@/server/site";

const TITLE = "Book a Studio";
const DESCRIPTION = "Reserve one or more studios at The Visuals Photo Studio. Instant confirmation.";

/**
 * The page's own address for search engines: one page, whichever studio a link chose (`?studio=`). And its own
 * title and description when a link to it is shared, in place of the website's.
 */
export async function generateMetadata(): Promise<Metadata> {
  return { title: TITLE, description: DESCRIPTION, ...(await shareMetadata({ title: TITLE, description: DESCRIPTION, path: "/book" })) };
}

export default async function BookPage() {
  const [catalog, policies] = await Promise.all([getCatalog(), checkoutPolicies()]);
  return (
    <>
      <div className="page-banner site-page">
        <p className="section-eyebrow">Online Booking</p>
        <h1>Reserve Your Studio</h1>
        <p>Start from the studio you want or from the time you want. Instant confirmation.</p>
      </div>
      <section className="section section-cream">
        {/* For clients without a photographer of their own. Only while sessions are on sale. */}
        {catalog.photoPackages.length > 0 && (
          <aside className="photographer-callout" aria-labelledby="photographer-callout-title">
            <div>
              <h2 id="photographer-callout-title">Don&rsquo;t have a photographer?</h2>
              <p>
                No problem! You can book a professional photoshoot with our in-house photographer, including studio
                rental.
              </p>
            </div>
            <Link href="/book/photography" className="btn btn-primary">
              Book a Photographer
            </Link>
          </aside>
        )}
        <p className="booking-request-note">
          After-hours bookings are available by request. Use the <Link href="/contact">contact form</Link> and choose
          &ldquo;After-hours booking&rdquo;.
        </p>
        <CodeBalanceCheck />
        {/* The flow reads ?studio= from the URL, so it renders on the client. */}
        <Suspense
          fallback={
            <div className="wizard-container" style={{ textAlign: "center" }}>
              <div className="spinner" />
            </div>
          }
        >
          <BookingFlow catalog={catalog} policies={policies} />
        </Suspense>
      </section>
    </>
  );
}
