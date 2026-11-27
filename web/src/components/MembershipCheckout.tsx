"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { joinMembershipAction } from "@/app/book/membership/actions";
import { formatCents } from "@/lib/domain/pricing";
import { durationLabel, longDateLabel } from "@/lib/domain/time";
import { EMAIL_FIELD } from "@/lib/parse";
import type { MembershipView } from "@/server/memberships";
import { CopyCode } from "./CopyCode";
import { buyerVerification, useCardForm } from "./square-card";
import { FAKE_PAYMENT_LABEL, FAKE_PAYMENT_NOTE, FAKE_PAYMENT_TOKEN } from "@/lib/fake-payment"; // FAKE PAYMENT

const CARD_CONTAINER = "membership-card";

/** Where a plan's hours can be spent: "in Studio Paris", or "in Studio Dayglow or Studio Paris, or in both booked together". */
function where(studios: string[]): string {
  if (studios.length <= 1) return `in ${studios[0] ?? "the studio"}`;
  const listed = `${studios.slice(0, -1).join(", ")} or ${studios[studios.length - 1]}`;
  return `in ${listed}, or in ${studios.length === 2 ? "both" : "several"} booked together`;
}

/**
 * The checkout of a membership (follow-up 3): the plan, the client's details, the terms to agree to and the card. Its
 * first month is charged when the client joins; the same card is then billed each month. Pressing again after no
 * answer sends the same attempt (its request id), so that nothing is bought twice; any answer starts a new one.
 */
export function MembershipCheckout({
  plan,
  prefill,
}: {
  plan: { id: string; name: string; description: string; minutes: number; priceCents: number; studios: string[] };
  prefill: { name: string; email: string };
}) {
  const [name, setName] = useState(prefill.name);
  const [email, setEmail] = useState(prefill.email);
  const [phone, setPhone] = useState("");
  const [terms, setTerms] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [joined, setJoined] = useState<MembershipView | null>(null);
  const router = useRouter();
  const card = useCardForm(joined === null, CARD_CONTAINER);
  const price = formatCents(plan.priceCents);

  async function join(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    // FAKE PAYMENT: which of the form's two buttons sent it.
    const fake = (event.nativeEvent as SubmitEvent).submitter?.hasAttribute("data-fake-payment") ?? false;
    // As the server checks them, before the card's bank is asked: spaces alone pass the fields' own length rules.
    if (name.trim().length < 2) {
      setError("Please enter your name.");
      return;
    }
    if (phone.trim().length < 7) {
      setError("Please enter your phone number.");
      return;
    }
    if (!terms) {
      setError("Please agree to the membership terms.");
      return;
    }
    setError("");
    setSending(true);
    try {
      // The card is kept for the monthly billing: the bank is told so when it checks the client (3-D Secure).
      const token = fake
        ? { ok: true as const, token: FAKE_PAYMENT_TOKEN } // FAKE PAYMENT
        : await card.token(buyerVerification({ amountCents: plan.priceCents, intent: "CHARGE_AND_STORE", name, email }));
      if (!token.ok) {
        setError(token.message);
        return;
      }
      const result = await joinMembershipAction({
        planId: plan.id,
        customer: { name: name.trim(), email: email.trim(), phone: phone.trim() },
        acceptTerms: true,
        paymentToken: token.token,
        requestId,
        // What the client sees and agrees to: changed meanwhile, nothing is charged and the page shows the new price.
        expected: { priceCents: plan.priceCents, minutes: plan.minutes },
      });
      if (result.ok) {
        setJoined(result.membership);
        return;
      }
      // Without an answer the same attempt is sent again, with the same card token, so that the card is charged once
      // (`useCardForm`); any other answer starts anew.
      if (result.code !== "no_answer") {
        setRequestId(crypto.randomUUID());
        card.newAttempt();
      }
      setError(result.message);
      if (result.code === "price_changed") {
        // The terms name the monthly price: they are agreed to again at the new one.
        setTerms(false);
        router.refresh();
      }
    } catch {
      setError("We could not reach the studio's site. Please press the button again: your card will not be charged twice.");
    } finally {
      setSending(false);
    }
  }

  if (joined) {
    return (
      <div className="wizard-panel active membership-joined" role="status">
        <h2>Welcome! Your membership has started.</h2>
        <p>
          {joined.planName}: {durationLabel(joined.minutesPerMonth)} of studio time each month. This month&apos;s hours are on
          your code now.
        </p>
        <p className="form-label">Your membership code</p>
        <CopyCode code={joined.code} />
        <p>
          We have emailed it to {joined.email}. Enter it at checkout when you book, with this email address.
          {joined.nextBilling && <> The next month is billed on {longDateLabel(joined.nextBilling)}.</>}
        </p>
        <div className="wizard-actions">
          <Link href="/account/membership" className="btn btn-outline">
            See it in your account
          </Link>
          <Link href="/book" className="btn btn-dark">
            Book a studio
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form className="wizard-panel active membership-checkout" onSubmit={join}>
      <div className="membership-checkout-plan">
        <h2>{plan.name}</h2>
        <p>
          <strong>{price} a month</strong> for {durationLabel(plan.minutes)} of studio time each month, {where(plan.studios)}.
        </p>
        <p>
          The first month is charged now. The same card is then billed {price} on the same day each month, until you
          cancel, which you can do at any time in your account. Unused hours carry over.
        </p>
      </div>

      <h3>Your details</h3>
      <div className="form-grid">
        <div className="form-group">
          <label className="form-label" htmlFor="member-name">
            Full name *
          </label>
          <input id="member-name" className="form-control" autoComplete="name" minLength={2} maxLength={120} required value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="member-email">
            Email address *
          </label>
          <input id="member-email" {...EMAIL_FIELD} className="form-control" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="member-phone">
            Phone number *
          </label>
          <input id="member-phone" type="tel" className="form-control" autoComplete="tel" minLength={7} maxLength={40} required value={phone} onChange={(event) => setPhone(event.target.value)} />
        </div>
      </div>

      <h3>Payment</h3>
      {!card.config && !card.problem && <p>Loading payment form…</p>}
      {card.config?.mode === "mock" && (
        <div className="notice notice-warning">
          <strong>Test mode.</strong> No card processor is connected, so no card will be charged. The membership will be
          started as if the payment succeeded.
        </div>
      )}
      {card.config?.mode === "disabled" && <div className="notice notice-warning">Online payment is not available right now. Please contact the studio.</div>}
      {card.config?.mode === "square" && (
        <>
          <span className="form-label">Card details</span>
          <div id={CARD_CONTAINER} />
          <p style={{ fontSize: ".75rem", marginTop: ".5rem" }}>Secured by Square. Card details never reach our servers.</p>
        </>
      )}
      {card.problem && (
        <div className="flash flash-error" role="alert">
          {card.problem}
        </div>
      )}

      <label className="addon-row" style={{ borderBottom: "none" }}>
        <input
          type="checkbox"
          checked={terms}
          onChange={(event) => {
            setTerms(event.target.checked);
            setError(""); // the usual reason an error is showing
          }}
        />
        <span>
          I have read and agree to the{" "}
          <Link href="/memberships#terms" target="_blank">
            membership terms
          </Link>
          , and to Square keeping my card to charge {price} each month until I cancel.
        </span>
      </label>
      {error && (
        <div className="flash flash-error" role="alert">
          {error}
        </div>
      )}
      <div className="wizard-actions">
        <Link href="/memberships" className="btn btn-outline">
          ← Memberships
        </Link>
        {/* FAKE PAYMENT: the wrapper holds the test button beside the real one, which stays first: Enter presses it. */}
        <div className="wizard-actions-pay">
          <button type="submit" className="btn btn-dark" disabled={sending || card.config?.mode === "disabled" || (card.config?.mode === "square" && !card.ready)}>
            {sending ? "Joining…" : `Pay ${price} and join`}
          </button>
          {card.config?.fakePayment && (
            <button type="submit" className="btn btn-outline" data-fake-payment disabled={sending}>
              {FAKE_PAYMENT_LABEL}
            </button>
          )}
        </div>
      </div>
      {card.config?.fakePayment && <p className="fake-payment-note">{FAKE_PAYMENT_NOTE}</p>}
    </form>
  );
}
