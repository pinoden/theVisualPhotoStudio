import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BookingFlow } from "@/components/BookingFlow";
import { SITE } from "@/lib/site";
import { getCatalog } from "@/server/cached";

export const metadata: Metadata = {
  title: "Book a Photographer",
  description:
    "Book a professional photoshoot with the in-house photographer of The Visuals Photo Studio. Studio rental is included.",
};

/**
 * The photography booking flow: a session with the in-house photographer, in
 * one studio, studio included. It is the booking screen with `photography`
 * set, so the steps, the payment and the rules are the ones a studio rental
 * has, and a time is offered only when both the studio and the photographer
 * are free.
 */
export default async function BookPhotographyPage() {
  const catalog = await getCatalog();
  return (
    <>
      <div className="page-banner">
        <p className="section-eyebrow">Photography</p>
        <h1>Book a Photographer</h1>
        <p>A professional photoshoot with our in-house photographer. Studio rental is included.</p>
      </div>
      <section className="section section-cream">
        {catalog.photoPackages.length === 0 ? (
          <div className="wizard-container" style={{ textAlign: "center" }}>
            <p>
              Photography sessions cannot be booked online right now. Please <Link href="/contact">send us a message</Link>{" "}
              or call <a href={SITE.phoneHref}>{SITE.phoneDisplay}</a>.
            </p>
            <Link href="/book" className="btn btn-dark">
              Rent a Studio
            </Link>
          </div>
        ) : (
          <>
            <p className="photographer-back">
              Have your own photographer? <Link href="/book">Rent a studio</Link>.
            </p>
            <Suspense
              fallback={
                <div className="wizard-container" style={{ textAlign: "center" }}>
                  <div className="spinner" />
                </div>
              }
            >
              <BookingFlow catalog={catalog} photography />
            </Suspense>
          </>
        )}
      </section>
    </>
  );
}
