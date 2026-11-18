import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { CancelMembership } from "@/components/CancelMembership";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/domain/pricing";
import { durationLabel, longDateLabel } from "@/lib/domain/time";
import { MINUTES_REASON_MAX, MINUTES_REASON_MIN, memberDetail, type MinutesLine } from "@/server/memberships";
import { requireOwner } from "@/server/session";
import { formatInstant, localDateOf } from "@/server/tz";
import { AdminFrame, AdminLoading } from "../../../frame";
import { cancelMemberAction, correctMinutesAction } from "../../actions";
import { MEMBER_STATE, nextOf } from "../../member-state";

export const metadata: Metadata = { title: "Member", robots: { index: false } };

export default function MemberPage(props: PageProps<"/admin/memberships/members/[id]">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Member params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

/** What a change to the minutes was, in words. */
function what(line: MinutesLine) {
  switch (line.kind) {
    case "month":
      return <>Month paid: {line.note.replace(/^The month from /, "from ").replace(/^The first month$/, "the first month")}</>;
    case "booking":
      return line.bookingRef ? (
        <>
          Booking <Link href={`/admin/appointments/${line.bookingRef}`}>{line.bookingRef}</Link>
        </>
      ) : (
        <>{line.note}</>
      );
    case "returned":
      return line.bookingRef ? (
        <>
          Given back: booking <Link href={`/admin/appointments/${line.bookingRef}`}>{line.bookingRef}</Link> cancelled
        </>
      ) : (
        <>Given back: {line.note}</>
      );
    default:
      return (
        <>
          {line.note} <small>({line.actor})</small>
        </>
      );
  }
}

/**
 * One membership, for the owners (step 5 of the plan under follow-up 3): its state, every change to its minutes and
 * every month paid; a correction of the minutes with a reason, and cancelling it for the member.
 */
async function Member({ params, searchParams }: Pick<PageProps<"/admin/memberships/members/[id]">, "params" | "searchParams">) {
  await connection();
  const { id } = await params;
  await requireOwner(`/admin/memberships/members/${encodeURIComponent(id)}`);
  const member = await memberDetail(await getDb(), id);
  if (!member) notFound();
  const today = localDateOf(new Date());

  return (
    <AdminFrame active="/admin/memberships" title={member.name} query={await searchParams}>
      <p>
        <Link href="/admin/memberships">← Memberships</Link>
      </p>
      <div className="admin-card membership-card">
        <h3>{member.planName}</h3>
        <p>
          {MEMBER_STATE[member.status]}
          {nextOf(member, today) ? `. ${nextOf(member, today)}.` : "."}
        </p>
        {member.problem && (
          <div className="flash flash-warning" role="status">
            {member.problem}
          </div>
        )}
        <dl className="reward-facts">
          <div>
            <dt>Hours left</dt>
            <dd>{member.minutesLeft > 0 ? durationLabel(member.minutesLeft) : "None"}</dd>
          </div>
          <div>
            <dt>Each month</dt>
            <dd>
              {durationLabel(member.minutesPerMonth)} for {formatCents(member.priceCents)}
            </dd>
          </div>
          <div>
            <dt>Member since</dt>
            <dd>{longDateLabel(member.startedOn)}</dd>
          </div>
          <div>
            <dt>Code</dt>
            <dd>{member.code}</dd>
          </div>
        </dl>
        <p className="account-small">
          <Link href={`/admin/customers/${encodeURIComponent(member.email)}`}>{member.email}</Link>
          {member.phone ? `, ${member.phone}` : ""}
        </p>
        {member.status === "active" && (
          <CancelMembership
            membershipId={member.id}
            planName={member.planName}
            endsOn={member.nextBilling ? longDateLabel(member.nextBilling) : null}
            action={cancelMemberAction}
            who="owner"
          />
        )}
      </div>

      <div className="admin-card">
        <h3>Hours</h3>
        {member.lines.length === 0 ? (
          <p>None yet.</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table history-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Change</th>
                  <th>What</th>
                </tr>
              </thead>
              <tbody>
                {member.lines.map((line, index) => (
                  <tr key={index}>
                    <td style={{ whiteSpace: "nowrap" }}>{formatInstant(line.at)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {line.minutes > 0 ? "+" : "−"}
                      {durationLabel(Math.abs(line.minutes))}
                    </td>
                    <td>{what(line)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {member.status !== "failed" && member.status !== "starting" && (
          <form action={correctMinutesAction} className="membership-correction">
            <input type="hidden" name="membershipId" value={member.id} />
            <div className="admin-form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="correct-hours">
                  Hours to add (a minus takes away)
                </label>
                <input id="correct-hours" name="hours" type="number" step={0.25} min={-100} max={100} className="form-control price-input" required />
              </div>
              <div className="form-group" style={{ flex: "2 1 16rem" }}>
                <label className="form-label" htmlFor="correct-reason">
                  Why
                </label>
                <input id="correct-reason" name="reason" className="form-control" minLength={MINUTES_REASON_MIN} maxLength={MINUTES_REASON_MAX} required />
              </div>
            </div>
            <button type="submit" className="btn btn-dark btn-small">
              Change the hours
            </button>
            <p className="account-small">Recorded with your reason. The member sees the hours in their account.</p>
          </form>
        )}
      </div>

      <div className="admin-card">
        <h3>Payments</h3>
        {member.payments.length === 0 ? (
          <p style={{ marginBottom: 0 }}>None.</p>
        ) : (
          <ul className="stamp-days">
            {member.payments.map((payment) => (
              <li key={payment.periodStart}>
                The month from {longDateLabel(payment.periodStart)}: {formatCents(payment.amountCents)}
                {payment.refunded ? " (refunded)" : ""}
              </li>
            ))}
          </ul>
        )}
      </div>
    </AdminFrame>
  );
}
