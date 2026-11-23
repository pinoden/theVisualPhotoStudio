import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BookingFlow } from "@/components/BookingFlow";
import { CodeBalanceCheck } from "@/components/CodeBalanceCheck";
import { telHref } from "@/lib/site/frame";
import { getCatalog } from "@/server/cached";
import { checkoutPolicies } from "../checkout-policies";
import { shareMetadata, siteFrame } from "@/server/site";

const TITLE = "Book a Photographer";
const DESCRIPTION =
  "Book a professional photoshoot with the in-house photographer of The Visuals Photo Studio. Studio rental is included.";

/** The page's own address for search engines, and its own title and description when a link to it is shared. */
export async function generateMetadata(): Promise<Metadata> {
  return { title: TITLE, description: DESCRIPTION, ...(await shareMetadata({ title: TITLE, description: DESCRIPTION, path: "/book/photography" })) };
}

/**
 * The photography booking flow: a session with the in-house photographer, in
 * one studio, studio included. It is the booking screen with `photography`
 * set, so the steps, the payment and the rules are the ones a studio rental
 * has, and a time is offered only when both the studio and the photographer
 * are free.
 */
export default async function BookPhotographyPage() {
  const [catalog, { frame }, policies] = await Promise.all([getCatalog(), siteFrame(), checkoutPolicies()]);
  const { business } = frame;
  return (
    <>
      <div className="page-banner site-page">
        <p className="section-eyebrow">Photography</p>
        <h1>Book a Photographer</h1>
        <p>A professional photoshoot with our in-house photographer. Studio rental is included.</p>
      </div>
      <section className="section section-cream">
        {catalog.photoPackages.length === 0 ? (
          <div className="wizard-container" style={{ textAlign: "center" }}>
            <p>
              Photography sessions cannot be booked online right now. Please <Link href="/contact">send us a message</Link>{" "}
              or call <a href={telHref(business.phone)}>{business.phone}</a>.
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
            <CodeBalanceCheck />
            <Suspense
              fallback={
                <div className="wizard-container" style={{ textAlign: "center" }}>
                  <div className="spinner" />
                </div>
              }
            >
              <BookingFlow catalog={catalog} photography policies={policies} />
            </Suspense>
          </>
        )}
      </section>
    </>
  );
}
