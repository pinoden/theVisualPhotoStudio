import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { MembershipCheckout } from "@/components/MembershipCheckout";
import { getCatalog } from "@/server/cached";
import { getDb } from "@/db/client";
import { ownDetails } from "@/server/own-details";
import { getCurrentUser } from "@/server/session";

export const metadata: Metadata = { title: "Join a Membership", robots: { index: false } };

/** Buying a membership (follow-up 3): the plan chosen on the Memberships page, the client's details and their card. */
export default function MembershipCheckoutPage(props: PageProps<"/book/membership">) {
  return (
    <>
      <div className="page-banner site-page">
        <p className="section-eyebrow">Memberships</p>
        <h1>Join a Membership</h1>
        <p>Studio hours every month. Cancel at any time.</p>
      </div>
      <section className="section section-cream">
        <div className="wizard-container">
          <Suspense fallback={<div className="spinner" />}>
            <Checkout searchParams={props.searchParams} />
          </Suspense>
        </div>
      </section>
    </>
  );
}

async function Checkout({ searchParams }: Pick<PageProps<"/book/membership">, "searchParams">) {
  await connection();
  const query = await searchParams;
  const catalog = await getCatalog();
  const plan = catalog.membershipPlans.find((candidate) => candidate.id === query.plan);
  if (!plan) {
    return (
      <div className="notice" role="status">
        {catalog.membershipPlans.length > 0 ? (
          <>
            Choose a membership on the <Link href="/memberships">Memberships</Link> page first.
          </>
        ) : (
          <>No membership is offered at the moment. Please contact the studio.</>
        )}
      </div>
    );
  }
  const user = await getCurrentUser();
  // A signed-in client's own name and phone number, as their latest booking has them (the owners' decision of 2026-11-27).
  const own = await ownDetails(await getDb(), user);
  const studios = plan.studioIds.map((id) => catalog.studios.find((studio) => studio.id === id)?.name ?? "").filter(Boolean);
  return <MembershipCheckout plan={{ ...plan, studios }} prefill={{ name: own?.name || user?.name || "", email: user?.email ?? "", phone: own?.phone ?? "" }} />;
}
