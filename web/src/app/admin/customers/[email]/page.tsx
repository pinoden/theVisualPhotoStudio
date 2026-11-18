import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { StampCard } from "@/components/StampCard";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/domain/pricing";
import { durationLabel, longDateLabel } from "@/lib/domain/time";
import { count } from "@/lib/words";
import { customerStatus, type AccountBooking } from "@/server/account";
import { getCustomer } from "@/server/customers";
import { money } from "@/server/receipt-pdf";
import { RECEIPT_STATUS_TEXT, yearsOf, yearStatement } from "@/server/receipts";
import { MAX_STAMPS_AT_ONCE, REASON_MAX, REASON_MIN, REWARD_STATUS_TEXT } from "@/server/rewards";
import { requireManager } from "@/server/session";
import { loadSettings } from "@/server/settings";
import { formatDay, formatInstant, formatRange } from "@/server/tz";
import { AdminFrame, AdminLoading } from "../../frame";
import { adjustStampsAction, cancelRewardAction, restoreRewardAction } from "../actions";

export const metadata: Metadata = { title: "Customer", robots: { index: false } };

export default function CustomerPage(props: PageProps<"/admin/customers/[email]">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Customer params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

const SOURCE_TEXT: Record<string, string> = {
  loyalty: "Earned by visits",
  manual: "Handed out by the studio",
  reschedule: "From a booking they moved",
  pet_fee: "A pet fee returned",
};

function Appointments({ bookings, seeMoney }: { bookings: AccountBooking[]; seeMoney: boolean }) {
  return (
    <div className="data-table-wrap">
      <table className="data-table history-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Appointment</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {bookings.map((booking) => {
            const when = formatRange(new Date(booking.startAt), new Date(booking.endAt));
            const status = customerStatus(booking);
            return (
              <tr key={booking.ref}>
                <td>
                  {when.day}
                  <br />
                  {when.time} ({durationLabel(booking.durationMinutes)})
                </td>
                <td>
                  <Link href={`/admin/appointments/${booking.ref}`}>
                    {booking.photography && "Photography session, "}
                    {booking.studios.map((studio) => studio.name).join(" + ")}
                  </Link>
                  <div style={{ fontSize: ".8rem" }}>
                    {booking.ref}
                    {seeMoney && ` · ${formatCents(booking.totalCents)}`}
                    {seeMoney && booking.dueCents > 0 && ` · ${formatCents(booking.dueCents)} still to pay`}
                  </div>
                  {booking.moves.map((move, index) => (
                    <div key={index} style={{ fontSize: ".8rem" }}>
                      {move}
                    </div>
                  ))}
                </td>
                <td>
                  <span className={`status-badge status-${status.badge}`}>{status.text}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One customer: their appointments, what they paid, their stamps and their
 * rewards, with the corrections. For the owners, and for a manager as far as
 * the owners' switches go: `getCustomer` leaves out the money and says
 * whether this viewer may correct anything. An attendant gets "not found".
 */
async function Customer({ params, searchParams }: Pick<PageProps<"/admin/customers/[email]">, "params" | "searchParams">) {
  await connection();
  const { email: segment } = await params;
  const address = decodeURIComponent(segment);
  const viewer = await requireManager(`/admin/customers/${encodeURIComponent(address)}`);
  const db = await getDb();
  const customer = await getCustomer(db, viewer, address, new Date());
  if (!customer) notFound();
  const { seeMoney, correctLoyalty } = customer.may;
  const query = await searchParams;
  const base = `/admin/customers/${encodeURIComponent(customer.email)}`;
  const years = yearsOf(customer.receipts);
  const known = customer.upcoming.length + customer.past.length > 0 || customer.hasAccount || customer.rewards.length > 0 || customer.stampChanges.length > 0;

  return (
    <AdminFrame active="/admin/customers" title={customer.name || customer.email} query={query} viewer={viewer} settings={await loadSettings(db)}>
      <p>
        <Link href="/admin/customers">← All customers</Link>
      </p>

      <div className="admin-card">
        <h3>Contact</h3>
        <dl className="detail-list">
          <dt>Email</dt>
          <dd>
            <a href={`mailto:${customer.email}`}>{customer.email}</a>
          </dd>
          {customer.phone && (
            <>
              <dt>Phone</dt>
              <dd>
                <a href={`tel:${customer.phone}`}>{customer.phone}</a>
              </dd>
            </>
          )}
          <dt>Account</dt>
          <dd>{customer.hasAccount ? "Has signed in to their account." : "Has never signed in. They can at any time, with this email address."}</dd>
        </dl>
        {!known && (
          <p className="field-error" style={{ marginBottom: 0 }}>
            Nothing is recorded for this address yet: no booking, no stamp, no reward. Check the spelling before changing anything.
          </p>
        )}
      </div>

      <div className="admin-card" id="loyalty">
        <h3>Loyalty stamps</h3>
        {customer.standing ? (
          <>
            <StampCard standing={customer.standing} perReward={customer.perReward} />
            <dl className="reward-facts stamp-facts">
              <div>
                <dt>Stamps in all</dt>
                <dd>{customer.standing.stamps}</dd>
              </div>
              <div>
                <dt>From visits</dt>
                <dd>{customer.standing.days.length}</dd>
              </div>
              <div>
                <dt>Added or taken by hand</dt>
                <dd>{customer.standing.adjustment > 0 ? `+${customer.standing.adjustment}` : customer.standing.adjustment}</dd>
              </div>
              <div>
                <dt>Free hours earned</dt>
                <dd>{customer.standing.earned}</dd>
              </div>
            </dl>
            {customer.standing.days.length > 0 && (
              <p style={{ fontSize: ".85rem" }}>
                Visits that gave a stamp: {[...customer.standing.days].reverse().map((entry) => longDateLabel(entry.day)).join("; ")}.
              </p>
            )}
          </>
        ) : (
          <p>Loyalty is switched off in Settings, so no stamps are counted.</p>
        )}

        {correctLoyalty && (
        <form action={adjustStampsAction} className="payment-form">
          <input type="hidden" name="email" value={customer.email} />
          <h4>Correct the stamps</h4>
          <div className="admin-form-row">
            <div className="form-group">
              <label className="form-label" htmlFor="stamp-direction">
                What to do
              </label>
              <select id="stamp-direction" name="direction" className="form-control" defaultValue="add" required>
                <option value="add">Add stamps</option>
                <option value="take">Take stamps away</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="stamp-number">
                How many
              </label>
              <input
                id="stamp-number"
                name="stamps"
                type="number"
                className="form-control"
                min={1}
                max={MAX_STAMPS_AT_ONCE}
                step={1}
                defaultValue={1}
                required
              />
            </div>
            <div className="form-group" style={{ flex: "1 1 14rem" }}>
              <label className="form-label" htmlFor="stamp-reason">
                Why
              </label>
              <input id="stamp-reason" name="reason" className="form-control" minLength={REASON_MIN} maxLength={REASON_MAX} required />
            </div>
            <button type="submit" className="btn btn-dark btn-small">
              Change stamps
            </button>
          </div>
          <p style={{ fontSize: ".78rem", margin: ".5rem 0 0" }}>
            For a visit the site never counted, or a stamp given by mistake. The visits themselves are not touched, and
            the change is recorded with your address and your reason. Stamps that complete a free hour send it to the
            customer at once.
          </p>
        </form>
        )}

        {customer.stampChanges.length > 0 && (
          <>
            <h4>Changes made by hand</h4>
            <ul className="plain-list" style={{ fontSize: ".85rem" }}>
              {customer.stampChanges.map((change, index) => (
                <li key={index}>
                  {formatInstant(new Date(change.at))}: {count(Math.abs(change.stamps), "stamp")} {change.stamps > 0 ? "added" : "taken away"} by{" "}
                  {change.actor}. {change.reason}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="admin-card" id="rewards">
        <h3>Rewards</h3>
        {customer.rewards.length === 0 ? (
          <p>No reward yet.{viewer.role === "owner" && " A free hour can be handed out under Codes."}</p>
        ) : (
          <ul className="reward-list">
            {customer.rewards.map((reward) => (
              <li key={reward.id} className={`reward reward-${reward.status}`}>
                <div className="reward-head">
                  <strong>
                    {reward.name} · {reward.code}
                  </strong>
                  <span className={`reward-status reward-status-${reward.status}`}>{REWARD_STATUS_TEXT[reward.status]}</span>
                </div>
                <div style={{ fontSize: ".85rem" }}>
                  {SOURCE_TEXT[reward.source] ?? reward.source}. Issued {formatDay(new Date(reward.issuedAt))}
                  {reward.expiresAt ? `, ${reward.status === "expired" ? "expired" : "expires"} ${formatDay(new Date(reward.expiresAt))}` : ""}.
                  {reward.note && ` ${reward.note}.`}
                </div>
                {reward.redeemed && (
                  <div style={{ fontSize: ".85rem" }}>
                    Redeemed on {formatDay(new Date(reward.redeemed.at))} for{" "}
                    <Link href={`/admin/appointments/${reward.redeemed.bookingRef}`}>
                      the appointment on {formatInstant(new Date(reward.redeemed.visitAt))} ({reward.redeemed.bookingRef})
                    </Link>
                    .
                  </div>
                )}
                {correctLoyalty && reward.status === "available" && (
                  <form action={cancelRewardAction} className="reward-fix">
                    <input type="hidden" name="email" value={customer.email} />
                    <input type="hidden" name="codeId" value={reward.id} />
                    <label className="form-label" htmlFor={`cancel-${reward.id}`}>
                      Why it is cancelled
                    </label>
                    <input id={`cancel-${reward.id}`} name="reason" className="form-control" minLength={REASON_MIN} maxLength={REASON_MAX} required />
                    <button type="submit" className="btn btn-outline btn-small">
                      Cancel this reward
                    </button>
                  </form>
                )}
                {correctLoyalty && reward.status === "cancelled" && (
                  <form action={restoreRewardAction} className="reward-fix">
                    <input type="hidden" name="email" value={customer.email} />
                    <input type="hidden" name="codeId" value={reward.id} />
                    <label className="form-label" htmlFor={`restore-${reward.id}`}>
                      Why it is given back
                    </label>
                    <input id={`restore-${reward.id}`} name="reason" className="form-control" minLength={REASON_MIN} maxLength={REASON_MAX} required />
                    <button type="submit" className="btn btn-outline btn-small">
                      Give this reward back
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        {customer.rewardChanges.length > 0 && (
          <>
            <h4>Changes made by hand</h4>
            <ul className="plain-list" style={{ fontSize: ".85rem" }}>
              {customer.rewardChanges.map((change, index) => (
                <li key={index}>
                  {formatInstant(new Date(change.at))}: {change.code ?? "A reward"} {change.kind === "reward_cancelled" ? "cancelled" : "given back"} by{" "}
                  {change.actor}. {change.reason}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {customer.codes.length > 0 && (
        <div className="admin-card">
          <h3>Credit and discount codes</h3>
          <div className="data-table-wrap">
            <table className="data-table history-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Worth</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {customer.codes.map((code) => (
                  <tr key={code.id}>
                    <td>
                      <strong>{code.code}</strong>
                      <div style={{ fontSize: ".8rem" }}>
                        {SOURCE_TEXT[code.source] ?? code.source}, {formatDay(new Date(code.issuedAt))}
                        {code.note && `. ${code.note}`}
                      </div>
                    </td>
                    <td>{code.kind === "percent" ? `${code.value}% off` : `${formatCents(code.value)} left`}</td>
                    <td>
                      {{ available: "Available", used: "Used", expired: "Expired", cancelled: "Cancelled" }[code.state]}
                      {code.expiresAt && code.state === "available" && <div style={{ fontSize: ".8rem" }}>until {formatDay(new Date(code.expiresAt))}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="admin-card" id="appointments">
        <h3>Appointments</h3>
        {customer.upcoming.length + customer.past.length === 0 && <p style={{ marginBottom: 0 }}>No booking under this email address.</p>}
        {customer.upcoming.length > 0 && (
          <>
            <h4>Upcoming ({customer.upcoming.length})</h4>
            <Appointments bookings={customer.upcoming} seeMoney={seeMoney} />
          </>
        )}
        {customer.past.length > 0 && (
          <>
            <h4>Past ({customer.past.length})</h4>
            <Appointments bookings={customer.past} seeMoney={seeMoney} />
          </>
        )}
      </div>

      {seeMoney && (
      <div className="admin-card" id="payments">
        <h3>Payments and receipts</h3>
        {customer.unpaid.length > 0 && (
          <ul className="plain-list">
            {customer.unpaid.map((booking) => (
              <li key={booking.ref}>
                <strong>{money(booking.dueCents)} to pay</strong> for{" "}
                <Link href={`/admin/appointments/${booking.ref}`}>
                  {booking.studios} on {formatInstant(new Date(booking.visitStart))}
                </Link>
                . Nothing has been paid for it yet.
              </li>
            ))}
          </ul>
        )}
        {customer.receipts.length === 0 && <p style={{ marginBottom: 0 }}>No payment has been recorded for this customer.</p>}
        {years.map((year) => {
          const statement = yearStatement(customer.receipts, year);
          return (
            <div key={year} className="customer-year">
              <h4>
                {year}: {money(statement.paidCents)} paid
                {statement.refundedCents > 0 && `, ${money(statement.refundedCents)} refunded`}
              </h4>
              <p className="account-actions">
                <a href={`${base}/receipts/year/${year}/pdf`} className="btn btn-outline btn-small">
                  All {year} receipts (PDF)
                </a>
              </p>
              <ul className="receipt-list">
                {statement.receipts.map((receipt) => (
                  <li key={receipt.ref}>
                    <div className="receipt-row-main">
                      <strong>{formatDay(new Date(receipt.paidAt))}</strong>
                      <span>
                        <Link href={`/admin/appointments/${receipt.ref}`}>
                          {receipt.studios}, appointment {formatInstant(new Date(receipt.visitStart))}
                        </Link>
                      </span>
                      <span className="account-small">
                        {receipt.ref} · {receipt.payments.map((payment) => payment.how).join("; ")} · {RECEIPT_STATUS_TEXT[receipt.status]}
                        {receipt.refundedCents > 0 && `: ${money(receipt.refundedCents)} given back`}
                      </span>
                    </div>
                    <div className="receipt-row-amount">{money(receipt.paidCents)}</div>
                    <div className="receipt-row-links">
                      <a href={`${base}/receipts/${receipt.ref}/pdf`} className="btn btn-outline btn-small">
                        Receipt (PDF)
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      )}
    </AdminFrame>
  );
}
