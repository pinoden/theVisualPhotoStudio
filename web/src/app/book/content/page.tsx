import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BookingFlow } from "@/components/BookingFlow";
import { CodeBalanceCheck } from "@/components/CodeBalanceCheck";
import { sessionsOf } from "@/lib/domain/services";
import { telHref } from "@/lib/site/frame";
import { getCatalog } from "@/server/cached";
import { checkoutPolicies } from "../checkout-policies";
import { shareMetadata, siteFrame } from "@/server/site";

const TITLE = "Book Content Creation";
const DESCRIPTION =
  "Book a content creation session at The Visuals Photo Studio: reels and stories made for you with an iPhone by the studio's own content creator. Studio rental is included.";

/** The page's own address for search engines, and its own title and description when a link to it is shared. */
export async function generateMetadata(): Promise<Metadata> {
  return { title: TITLE, description: DESCRIPTION, ...(await shareMetadata({ title: TITLE, description: DESCRIPTION, path: "/book/content" })) };
}

/**
 * The content creation booking flow (the owner's answer of 2026-11-23: "it's when I'm creating reels/stories for a
 * customer using iPhone, that's similar to a session with a photographer"; question 69 in ProjectLibrary.md): the
 * photography flow with the content creator's sessions, hours and days off. Nothing can be booked here until the owners
 * put a session on sale under Admin → Content Creation.
 */
export default async function BookContentPage() {
  const [catalog, { frame }, policies] = await Promise.all([getCatalog(), siteFrame(), checkoutPolicies()]);
  const { business } = frame;
  return (
    <>
      <div className="page-banner site-page">
        <p className="section-eyebrow">Content Creation</p>
        <h1>Book Content Creation</h1>
        <p>Reels and stories made for you with an iPhone by our in-house content creator. Studio rental is included.</p>
      </div>
      <section className="section section-cream">
        {sessionsOf(catalog.photoPackages, "content").length === 0 ? (
          <div className="wizard-container" style={{ textAlign: "center" }}>
            <p>
              Content creation sessions cannot be booked online right now. Please <Link href="/contact">send us a message</Link>{" "}
              or call <a href={telHref(business.phone)}>{business.phone}</a>.
            </p>
            <Link href="/book" className="btn btn-dark">
              Rent a Studio
            </Link>
          </div>
        ) : (
          <>
            <p className="photographer-back">
              Making your own content? <Link href="/book">Rent a studio</Link>.
            </p>
            <CodeBalanceCheck />
            <Suspense
              fallback={
                <div className="wizard-container" style={{ textAlign: "center" }}>
                  <div className="spinner" />
                </div>
              }
            >
              <BookingFlow catalog={catalog} photography service="content" policies={policies} />
            </Suspense>
          </>
        )}
      </section>
    </>
  );
}
