import { CopyCode } from "@/components/CopyCode";
import { REWARD_STATUS_TEXT, type Reward } from "@/server/rewards";
import { formatDay, formatInstant } from "@/server/tz";

/**
 * A customer's rewards, each with its code, the day it was issued, the day it
 * expires and its status. A reward that can still be used has a button that
 * copies its code; a used one says when, and for which appointment.
 */
export function RewardList({ rewards }: { rewards: Reward[] }) {
  if (rewards.length === 0) return null;
  return (
    <ul className="reward-list">
      {rewards.map((reward) => (
        <li key={reward.id} className={`reward reward-${reward.status}`}>
          <div className="reward-head">
            <strong>{reward.name}</strong>
            <span className={`reward-status reward-status-${reward.status}`}>{REWARD_STATUS_TEXT[reward.status]}</span>
          </div>
          {reward.status === "available" ? <CopyCode code={reward.code} /> : <div className="reward-code-spent">{reward.code}</div>}
          <dl className="reward-facts">
            <div>
              <dt>Issued</dt>
              <dd>{formatDay(new Date(reward.issuedAt))}</dd>
            </div>
            <div>
              <dt>{reward.status === "expired" ? "Expired" : "Expires"}</dt>
              <dd>{reward.expiresAt ? formatDay(new Date(reward.expiresAt)) : "Never"}</dd>
            </div>
          </dl>
          {reward.redeemed && (
            <p className="reward-note">
              Used on {formatDay(new Date(reward.redeemed.at))} for your appointment on {formatInstant(new Date(reward.redeemed.visitAt))} (
              {reward.redeemed.bookingRef}).
            </p>
          )}
          {reward.status === "available" && (
            <p className="reward-note">One hour free in any one studio. Enter the code at checkout, with this email address.</p>
          )}
          {reward.status === "cancelled" && <p className="reward-note">This reward was cancelled by the studio and can no longer be used.</p>}
        </li>
      ))}
    </ul>
  );
}
