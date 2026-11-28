import type { Metadata } from "next";
import { sessionsOf } from "@/lib/domain/services";
import Link from "next/link";
import { Suspense } from "react";
import { BookingFlow } from "@/components/BookingFlow";
import { CodeBalanceCheck } from "@/components/CodeBalanceCheck";
import { getCatalog } from "@/server/cached";
import { checkoutPolicies } from "./checkout-policies";
import { isPreview, shareMetadata } from "@/server/site";

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
  // In a preview nothing a first pass draws is kept (Draft Mode), so the cached reads below would be missing in the
  // final pass, which Next.js logs as an error for each ("Unexpected cache miss after cache warming"): 250 times in a
  // run of the browser suite, until 2026-11-28. A preview is drawn when it is asked for (`isPreview`), so it is asked
  // first. For a visitor it answers at once, and the page stays prerendered.
  await isPreview();
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
        {sessionsOf(catalog.photoPackages, "photography").length > 0 && (
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
        {/* Content creation (question 69): only once the owners put a session on sale. */}
        {sessionsOf(catalog.photoPackages, "content").length > 0 && (
          <aside className="photographer-callout" aria-labelledby="content-callout-title">
            <div>
              <h2 id="content-callout-title">Want reels or stories made for you?</h2>
              <p>Book a content creation session: our in-house content creator films them with an iPhone, studio rental included.</p>
            </div>
            <Link href="/book/content" className="btn btn-primary">
              Book Content Creation
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
