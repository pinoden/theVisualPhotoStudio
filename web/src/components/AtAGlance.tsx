import type { LoyaltyStanding } from "@/lib/domain/loyalty";
import { formatCents } from "@/lib/domain/pricing";
import { durationLabel } from "@/lib/domain/time";
import type { AtAGlance } from "@/server/account";
import { formatDay } from "@/server/tz";

/**
 * A client's loyalty in figures, beside the stamp card (the owner's answer of 2026-11-23, question 72): the stamps
 * collected, the free hours earned, and those still to use.
 */
export function LoyaltyFacts({ standing, glance }: { standing: LoyaltyStanding; glance: AtAGlance }) {
  return (
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
        <dt>Free hours to use</dt>
        <dd>
          {glance.freeHours === 0 ? "None" : glance.freeHours}
          {glance.firstFreeHourEnds && `, the first until ${formatDay(new Date(glance.firstFreeHourEnds))}`}
        </dd>
      </div>
    </dl>
  );
}

/** What is left on a client's codes and membership, in total, when there is any (question 72). */
export function BalanceFacts({ glance, member }: { glance: AtAGlance; /** Whether the client has a membership. */ member: boolean }) {
  const facts: [string, string][] = [];
  if (glance.creditCents > 0) facts.push(["Studio credit", formatCents(glance.creditCents)]);
  if (glance.photoCreditCents > 0) facts.push(["Photography credit", formatCents(glance.photoCreditCents)]);
  if (glance.discounts > 0) facts.push(["Discount codes", String(glance.discounts)]);
  if (member) facts.push(["Membership hours left", glance.membershipMinutes > 0 ? durationLabel(glance.membershipMinutes) : "None"]);
  if (facts.length === 0) return null;
  return (
    <dl className="reward-facts balance-facts">
      {facts.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
