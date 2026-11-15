import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/domain/pricing";
import { SITE } from "@/lib/site";
import { getPayPage } from "@/server/pay-links";
import { flushEmailsSoon, payLinkDeps } from "@/server/runtime";
import { pretendPayAction } from "./actions";

export const metadata: Metadata = {
  title: "Pay for Your Booking",
  // The address is known only to the client it was emailed to.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * Where a payment link in a client's email leads: what their booking still
 * owes, and a button to the card processor's payment page. The processor
 * sends the client back here afterwards, and opening the page asks the
 * processor whether the link was paid, so they see that it arrived.
 */
export default function PayPage(props: PageProps<"/pay/[id]">) {
  return (
    <section className="section section-cream">
      <Suspense
        fallback={
          <div className="confirmation-card">
            <div className="spinner" />
          </div>
        }
      >
        <Pay params={props.params} />
      </Suspense>
    </section>
  );
}

async function Pay({ params }: Pick<PageProps<"/pay/[id]">, "params">) {
  // Always rendered for the incoming request: whether a link was paid is live.
  await connection();
  const { id } = await params;
  const page = await getPayPage(await getDb(), id, await payLinkDeps());
  if (!page) notFound();
  // A payment found on this visit queued its confirmation email.
  flushEmailsSoon();
  const amount = formatCents(page.amountCents);

  const details = (
    <div className="price-summary">
      <div className="price-row">
        <span>Booking</span>
        <strong>{page.ref}</strong>
      </div>
      <div className="price-row">
        <span>Studio</span>
        <strong>{page.studios}</strong>
      </div>
      <div className="price-row">
        <span>When</span>
        <strong>{page.when}</strong>
      </div>
      <div className="price-row total">
        <span>{page.status === "paid" ? "Paid" : "To pay"}</span>
        <span>{amount}</span>
      </div>
    </div>
  );

  return (
    <div className="confirmation-card" style={{ textAlign: "left" }}>
      <div style={{ textAlign: "center" }}>
        <div className="confirmation-icon">{page.status === "paid" ? "✓" : page.status === "cancelled" ? "×" : "$"}</div>
        <h1 style={{ fontSize: "2rem" }}>
          {page.status === "paid" ? "Payment Received" : page.status === "cancelled" ? "This Link Is No Longer Valid" : "Pay for Your Booking"}
        </h1>
        <div className="divider" />
      </div>

      {page.status === "paid" && (
        <>
          <p>Thank you. Your payment of {amount} has been received, and we have emailed you a confirmation.</p>
          {details}
        </>
      )}

      {page.status === "cancelled" && (
        <p>
          This payment link was cancelled, so nothing can be paid here. If you still need to pay for booking {page.ref},
          please call us at <a href={SITE.phoneHref}>{SITE.phoneDisplay}</a> or pay at the studio.
        </p>
      )}

      {page.status === "open" && (
        <>
          {details}
          {page.pretend ? (
            <>
              <div className="notice notice-warning">
                <strong>Test mode.</strong> No card processor is connected, so no card will be charged. The payment
                will be recorded as if it had been made.
              </div>
              <form action={pretendPayAction} style={{ textAlign: "center" }}>
                <input type="hidden" name="id" value={page.id} />
                <button type="submit" className="btn btn-dark">
                  Pay {amount} (test mode)
                </button>
              </form>
            </>
          ) : (
            <>
              <p style={{ textAlign: "center" }}>
                <a href={page.processorUrl ?? "#"} className="btn btn-dark">
                  Pay {amount} by card
                </a>
              </p>
              <p style={{ fontSize: ".85rem" }}>
                The card payment page is run by Square, our card processor: your card details never reach us. You are
                brought back here once you have paid. If you have just paid and this page does not say so yet, open it
                again in a minute.
              </p>
            </>
          )}
          <p style={{ fontSize: ".85rem" }}>You can also pay at the studio.</p>
        </>
      )}

      <div style={{ display: "flex", gap: "1rem", justifyContent: "center", marginTop: "2rem", flexWrap: "wrap" }}>
        <Link href="/" className="btn btn-outline">
          Back to Home
        </Link>
      </div>
    </div>
  );
}
