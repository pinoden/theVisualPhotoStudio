import { stampsNeededInWords, type LoyaltyStanding } from "@/lib/domain/loyalty";

/**
 * A customer's stamps towards their next free hour: a row of circles, the
 * count, and how many are still needed. With more than ten stamps to a
 * reward the circles would not fit a phone, so only the count is shown.
 */
export function StampCard({ standing, perReward }: { standing: LoyaltyStanding; perReward: number }) {
  const circles = perReward >= 1 && perReward <= 10;
  return (
    <div className="stamp-card">
      {circles && (
        <div className="stamp-row" role="img" aria-label={`${standing.towardsNext} of ${perReward} stamps`}>
          {Array.from({ length: perReward }, (_, index) => (
            <span key={index} className={`stamp${index < standing.towardsNext ? " stamp-filled" : ""}`} aria-hidden="true">
              {index < standing.towardsNext ? "✓" : ""}
            </span>
          ))}
        </div>
      )}
      <div className="stamp-count">
        {standing.towardsNext} / {perReward}
      </div>
      <p className="stamp-needed">{stampsNeededInWords(standing.needed)} until your free studio hour</p>
    </div>
  );
}
