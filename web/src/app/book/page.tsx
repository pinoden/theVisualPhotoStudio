import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BookingFlow } from "@/components/BookingFlow";
import { getCatalog } from "@/server/cached";

export const metadata: Metadata = {
  title: "Book a Studio",
  description: "Reserve one or more studios at The Visuals Photo Studio. Instant confirmation.",
};

export default async function BookPage() {
  const catalog = await getCatalog();
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
        {/* The flow reads ?studio= from the URL, so it renders on the client. */}
        <Suspense
          fallback={
            <div className="wizard-container" style={{ textAlign: "center" }}>
              <div className="spinner" />
            </div>
          }
        >
          <BookingFlow catalog={catalog} />
        </Suspense>
      </section>
    </>
  );
}
