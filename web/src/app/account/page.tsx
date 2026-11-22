import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { AccountFrame } from "@/components/AccountFrame";
import { ChangeEmailForm } from "@/components/ChangeEmailForm";
import { CopyCode } from "@/components/CopyCode";
import { StampCard } from "@/components/StampCard";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/domain/pricing";
import { durationLabel } from "@/lib/domain/time";
import { count } from "@/lib/words";
import { customerStatus, loadAppointments } from "@/server/account";
import { pendingEmailChange } from "@/server/email-change";
import { getCatalog } from "@/server/cached";
import { loyaltyStandingOf } from "@/server/loyalty";
import { listCodesForEmail } from "@/server/promos";
import { listRewards } from "@/server/rewards";
import { requireUser } from "@/server/session";
import { loadSettings } from "@/server/settings";
import { formatDay, formatRange } from "@/server/tz";

export const metadata: Metadata = { title: "My Account", robots: { index: false } };

export default function AccountPage() {
  return (
    <>
      <div className="page-banner">
        <p className="section-eyebrow">My Account</p>
        <h1>Your Account</h1>
      </div>
      <section className="section section-cream">
        <div className="container-sm">
          <Suspense fallback={<div className="spinner" />}>
            <Overview />
          </Suspense>
        </div>
      </section>
    </>
  );
}

/**
 * What a customer sees first after signing in: their next appointment, their
 * stamps towards a free hour, the rewards and credit they can use, and the
 * ways on to everything else.
 */
async function Overview() {
  await connection();
  const user = await requireUser("/account");
  const db = await getDb();
  const now = new Date();
  const [{ upcoming }, settings, rewards, codes, catalog, waiting] = await Promise.all([
    loadAppointments(db, user.email, now),
    loadSettings(db),
    listRewards(db, user.email, now),
    listCodesForEmail(db, user.email, now),
    getCatalog(),
    user.role === "customer" ? pendingEmailChange(db, user, now) : null,
  ]);
  const standing = settings.loyaltyEnabled ? await loyaltyStandingOf(db, user.email, settings) : null;
  const next = upcoming[0] ?? null;
  const when = next ? formatRange(new Date(next.startAt), new Date(next.endAt)) : null;
  const available = rewards.filter((reward) => reward.status === "available");
  // Credit and discount codes: everything usable that is not a reward.
  const credits = codes.filter((code) => code.kind !== "free_hour");

  return (
    <AccountFrame user={user} active="/account">
      <div className="account-grid">
        <div className="admin-card account-card">
          <h3>Your next appointment</h3>
          {next && when ? (
            <>
              <p className="account-next">
                <strong>{when.day}</strong>
                <br />
                {when.time} ({durationLabel(next.durationMinutes)})
              </p>
              <p>
                {next.photography && "Photography session, "}
                {next.studios.map((studio) => studio.name).join(" + ")}{" "}
                <span className={`status-badge status-${customerStatus(next).badge}`}>{customerStatus(next).text}</span>
              </p>
              <p className="account-actions">
                <Link href={`/account/appointments#${next.ref}`} className="btn btn-outline btn-small">
                  Details and changes
                </Link>
              </p>
            </>
          ) : (
            <p>You have no upcoming appointments.</p>
          )}
          <p className="account-actions">
            <Link href="/account/appointments" className="btn btn-dark btn-small">
              View all appointments
            </Link>
          </p>
          {upcoming.length > 1 && <p className="account-small">{count(upcoming.length, "upcoming appointment")} in all.</p>}
        </div>

        {standing && (
          <div className="admin-card account-card">
            <h3>My Loyalty Rewards</h3>
            <StampCard standing={standing} perReward={settings.loyaltyVisits} />
            <p className="account-small">
              Every {count(settings.loyaltyVisits, "visit")}, on separate days, earn one free hour in any studio.
            </p>
            <p className="account-actions">
              <Link href="/account/rewards" className="btn btn-outline btn-small">
                My stamps and rewards
              </Link>
            </p>
          </div>
        )}

        <div className="admin-card account-card">
          <h3>Rewards you can use</h3>
          {available.length === 0 && credits.length === 0 && <p>You have no reward or credit to use right now.</p>}
          {available.map((reward) => (
            <div className="account-code" key={reward.id}>
              <strong>{reward.name}</strong>
              <CopyCode code={reward.code} />
              <span className="account-small">{reward.expiresAt ? `Valid until ${formatDay(new Date(reward.expiresAt))}` : "Does not expire"}</span>
            </div>
          ))}
          {credits.map((code) => (
            <div className="account-code" key={code.code}>
              <strong>
                {code.kind === "percent"
                  ? `${code.value}% off your next ${code.photographyOnly ? "photography session" : "studio rental"}`
                  : code.source === "reschedule"
                    ? `${formatCents(code.value)} ${code.photographyOnly ? "photography " : ""}credit from a rescheduled booking`
                    : code.source === "pet_fee"
                      ? `${formatCents(code.value)} studio credit, from a pet fee`
                      : `${formatCents(code.value)} studio credit`}
              </strong>
              <CopyCode code={code.code} />
              <span className="account-small">{code.expiresAt ? `Valid until ${formatDay(new Date(code.expiresAt))}` : "Does not expire"}</span>
            </div>
          ))}
          <p className="account-actions">
            <Link href="/account/rewards" className="btn btn-outline btn-small">
              All my rewards
            </Link>
          </p>
        </div>

        <div className="admin-card account-card">
          <h3>Receipts &amp; Payments</h3>
          <p>Everything you have paid, with a receipt for each booking and a summary for each year.</p>
          <p className="account-actions">
            <Link href="/account/receipts" className="btn btn-outline btn-small">
              Receipts and payment history
            </Link>
          </p>
        </div>

        {user.role === "customer" && (
          <div className="admin-card account-card" id="email-address">
            <h3>Your email address</h3>
            <p>
              Your bookings, receipts, stamps and codes are kept under <strong>{user.email}</strong>, and our emails go
              there. To use another address, we first email a code to it.
            </p>
            <ChangeEmailForm waiting={waiting} />
          </div>
        )}
      </div>

      <div className="account-book">
        <Link href="/book" className="btn btn-primary">
          Book a studio
        </Link>
        {catalog.photoPackages.length > 0 && (
          <Link href="/book/photography" className="btn btn-outline">
            Book a photographer
          </Link>
        )}
      </div>
    </AccountFrame>
  );
}
