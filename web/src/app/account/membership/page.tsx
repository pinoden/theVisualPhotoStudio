import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { AccountFrame } from "@/components/AccountFrame";
import { CancelMembership } from "@/components/CancelMembership";
import { CopyCode } from "@/components/CopyCode";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/domain/pricing";
import { durationLabel, longDateLabel } from "@/lib/domain/time";
import { membershipPaymentsOf, membershipsOf, minutesLinesOf, type MembershipView, type MinutesLine } from "@/server/memberships";
import { requireUser } from "@/server/session";
import { formatInstant } from "@/server/tz";

export const metadata: Metadata = { title: "My Membership", robots: { index: false } };

export default function MembershipPage() {
  return (
    <>
      <div className="page-banner">
        <p className="section-eyebrow">My Account</p>
        <h1>My Membership</h1>
      </div>
      <section className="section section-cream">
        <div className="container-sm">
          <Suspense fallback={<div className="spinner" />}>
            <Membership />
          </Suspense>
        </div>
      </section>
    </>
  );
}

/** Where a membership stands, in a sentence. */
function standing(membership: MembershipView): string {
  switch (membership.status) {
    case "active":
      return membership.nextBilling ? `Active. The next month is billed on ${longDateLabel(membership.nextBilling)}: ${formatCents(membership.priceCents)}.` : "Active.";
    case "cancelled":
      return membership.endsOn
        ? `Cancelled: no more monthly payments. The month you paid for runs until ${longDateLabel(membership.endsOn)}. Your hours stay yours.`
        : "Cancelled: no more monthly payments. Your hours stay yours.";
    case "starting":
      return "Being set up: its first payment has not been confirmed yet. Please look again in a moment.";
    default:
      return "Stopped: the monthly payments did not go through. Your hours stay yours. Please contact the studio.";
  }
}

/** What a change to the member's hours was, in their words. The studio's reason for a correction is its own. */
function hoursWhat(line: MinutesLine) {
  const booking = (ref: string) => <Link href={`/account/appointments#${ref}`}>{ref}</Link>;
  switch (line.kind) {
    case "month":
      // "The first month paid", "The month from Monday, December 14, 2026 paid".
      return <>{line.note} paid</>;
    case "booking":
      return line.bookingRef ? <>Booking {booking(line.bookingRef)}</> : <>A booking</>;
    case "returned":
      return line.bookingRef ? <>Given back: booking {booking(line.bookingRef)} was cancelled</> : <>Given back</>;
    default:
      return <>Changed by the studio</>;
  }
}

/** A member's memberships: each one's hours left, its code, how it is billed, its payments, every change to its hours, and cancelling it. */
async function Membership() {
  await connection();
  const user = await requireUser("/account/membership");
  const db = await getDb();
  const found = await membershipsOf(db, user.email);
  const payments = new Map<string, Awaited<ReturnType<typeof membershipPaymentsOf>>>();
  const hours = new Map<string, MinutesLine[]>();
  for (const membership of found) {
    payments.set(membership.id, await membershipPaymentsOf(db, membership.id));
    hours.set(membership.id, await minutesLinesOf(db, membership.id));
  }

  return (
    <AccountFrame user={user} active="/account/membership">
      {found.length === 0 && (
        <div className="admin-card">
          <h3>No membership yet</h3>
          <p style={{ marginBottom: 0 }}>
            A membership gives you studio hours every month. See the plans on the <Link href="/memberships">Memberships</Link> page.
          </p>
        </div>
      )}
      {found.map((membership) => (
        <div className="admin-card membership-card" key={membership.id}>
          <h3>{membership.planName}</h3>
          <p>{standing(membership)}</p>
          <dl className="reward-facts">
            <div>
              <dt>Hours left</dt>
              <dd>{membership.minutesLeft > 0 ? durationLabel(membership.minutesLeft) : "None"}</dd>
            </div>
            <div>
              <dt>Each month</dt>
              <dd>
                {durationLabel(membership.minutesPerMonth)} for {formatCents(membership.priceCents)}
              </dd>
            </div>
            <div>
              <dt>Member since</dt>
              <dd>{longDateLabel(membership.startedOn)}</dd>
            </div>
          </dl>
          <p className="form-label">Your membership code</p>
          <CopyCode code={membership.code} />
          <p className="account-small">Enter it at checkout when you book, with this email address. Unused hours carry over.</p>

          <h4>Payments</h4>
          <ul className="stamp-days">
            {(payments.get(membership.id) ?? []).map((payment) => (
              <li key={payment.periodStart}>
                {longDateLabel(payment.periodStart)}: {formatCents(payment.amountCents)}
                {payment.refunded ? " (refunded)" : ""}
              </li>
            ))}
          </ul>

          <h4>Your hours</h4>
          <ul className="stamp-days">
            {(hours.get(membership.id) ?? []).map((line, index) => (
              <li key={index}>
                {formatInstant(line.at)}: {line.minutes > 0 ? "+" : "−"}
                {durationLabel(Math.abs(line.minutes))} · {hoursWhat(line)}
              </li>
            ))}
          </ul>
          {/* In place once cancelled too: its message stays after the page is drawn again. */}
          <CancelMembership
            membershipId={membership.id}
            planName={membership.planName}
            endsOn={membership.nextBilling ? longDateLabel(membership.nextBilling) : null}
            active={membership.status === "active"}
          />
        </div>
      ))}
    </AccountFrame>
  );
}
