import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { AccountFrame } from "@/components/AccountFrame";
import { BalanceFacts } from "@/components/AtAGlance";
import { CopyCode } from "@/components/CopyCode";
import { RewardList } from "@/components/RewardList";
import { StampCard } from "@/components/StampCard";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/domain/pricing";
import { longDateLabel } from "@/lib/domain/time";
import { count } from "@/lib/words";
import { atAGlance } from "@/server/account";
import { listStampChanges, loyaltyStandingOf } from "@/server/loyalty";
import { membershipsOf } from "@/server/memberships";
import { listCodesForEmail } from "@/server/promos";
import { listRewards } from "@/server/rewards";
import { requireUser } from "@/server/session";
import { loadSettings, loyaltyStart } from "@/server/settings";
import { formatDay, formatInstant } from "@/server/tz";

export const metadata: Metadata = { title: "My Rewards", robots: { index: false } };

export default function RewardsPage() {
  return (
    <>
      <div className="page-banner">
        <p className="section-eyebrow">My Account</p>
        <h1>My Rewards</h1>
      </div>
      <section className="section section-cream">
        <div className="container-sm">
          <Suspense fallback={<div className="spinner" />}>
            <Rewards />
          </Suspense>
        </div>
      </section>
    </>
  );
}

/**
 * A customer's loyalty in full: the stamps towards the next free hour and the
 * visits that gave them, every reward ever earned with its status, and the
 * credit they hold.
 */
async function Rewards() {
  await connection();
  const user = await requireUser("/account/rewards");
  const db = await getDb();
  const now = new Date();
  const [settings, rewards, codes, memberships] = await Promise.all([
    loadSettings(db),
    listRewards(db, user.email, now),
    listCodesForEmail(db, user.email, now),
    membershipsOf(db, user.email),
  ]);
  const member = memberships.some((membership) => membership.status !== "starting");
  const glance = atAGlance(rewards, codes, memberships);
  // After loyalty started over, the stamps are counted from that day: the changes from before it are not listed.
  const since = loyaltyStart(settings);
  const changes = await listStampChanges(db, user.email, since);
  const standing = settings.loyaltyEnabled ? await loyaltyStandingOf(db, user.email, settings) : null;
  const credits = codes.filter((code) => code.kind !== "free_hour");
  const perReward = settings.loyaltyVisits;

  return (
    <AccountFrame user={user} active="/account/rewards">
      {standing && (
        <div className="admin-card">
          <h3>My Loyalty Rewards</h3>
          <StampCard standing={standing} perReward={perReward} />
          <p>
            You collect one stamp for each day you visit, and {count(perReward, "stamp")} earn a free studio hour. We
            email you the code, and it appears below. Two bookings on one day are one stamp. A visit made with a free
            hour does not give a stamp, and neither does a photography session with our photographer.
            {since && <> Stamps are counted from {formatInstant(since)}, when the program started again. Free hours you already have stay valid.</>}
          </p>
          <dl className="reward-facts stamp-facts">
            <div>
              <dt>Stamps collected</dt>
              <dd>{standing.stamps}</dd>
            </div>
            <div>
              <dt>Free hours earned</dt>
              <dd>{standing.earned}</dd>
            </div>
            <div>
              <dt>Still needed</dt>
              <dd>{standing.needed}</dd>
            </div>
            <div>
              <dt>Free hours to use</dt>
              <dd>
                {glance.freeHours === 0 ? "None" : glance.freeHours}
                {glance.firstFreeHourEnds && `, the first until ${formatDay(new Date(glance.firstFreeHourEnds))}`}
              </dd>
            </div>
          </dl>

          <h4>Visits that gave a stamp</h4>
          {standing.days.length === 0 ? (
            <p className="account-small">None yet. A visit counts a little after it ends.</p>
          ) : (
            <ul className="stamp-days">
              {[...standing.days].reverse().map((entry) => (
                <li key={entry.day}>{longDateLabel(entry.day)}</li>
              ))}
            </ul>
          )}
          {changes.length > 0 && (
            <>
              <h4>Changes made by the studio</h4>
              <ul className="stamp-days">
                {changes.map((change, index) => (
                  <li key={index}>
                    {formatDay(new Date(change.at))}: {count(Math.abs(change.stamps), "stamp")} {change.stamps > 0 ? "added" : "taken away"}.{" "}
                    {change.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="admin-card">
        <h3>My Rewards</h3>
        {rewards.length === 0 ? (
          <p style={{ marginBottom: 0 }}>
            You have not earned a reward yet.{" "}
            {standing ? `Your first free studio hour comes with your ${ordinal(perReward)} stamp.` : ""}
          </p>
        ) : (
          <RewardList rewards={rewards} />
        )}
      </div>

      {(credits.length > 0 || member) && (
        <div className="admin-card">
          <h3>Credit and codes</h3>
          <BalanceFacts glance={glance} member={member} />
          {member && (
            <p className="account-small">
              Your membership&rsquo;s hours, its code and every change to them are on <Link href="/account/membership">My Membership</Link>.
            </p>
          )}
          {credits.length > 0 && <p className="account-small">These are not rewards: money from a booking you moved, credit from the studio, or a discount.</p>}
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
        </div>
      )}

      <div className="account-book">
        <Link href="/book" className="btn btn-primary">
          Book a studio
        </Link>
      </div>
    </AccountFrame>
  );
}

/** "5th", "1st", "22nd": for "your 5th stamp". */
function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}
