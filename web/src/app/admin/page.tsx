import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/domain/pricing";
import { countUpcoming, listBookings, listRefundProblems, listRefundsOwed } from "@/server/admin";
import { resolveEmailTransport } from "@/server/email";
import { SCHEDULER_STALE_MINUTES, schedulerLastRun, schedulerState } from "@/server/heartbeat";
import { resolvePayments } from "@/server/payments";
import { requireUser } from "@/server/session";
import { otherMoneyNotice } from "@/server/test-mode";
import { formatInstant, localDateOf } from "@/server/tz";
import { recordRefundMadeInSquareAction } from "./actions";
import { AdminFrame, AdminLoading } from "./frame";

export const metadata: Metadata = { title: "Admin", robots: { index: false } };

export default function AdminPage(props: PageProps<"/admin">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Overview searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Overview({ searchParams }: Pick<PageProps<"/admin">, "searchParams">) {
  await connection();
  // The Overview is the owners'. A manager or an attendant who types the admin's own address is sent to the page they
  // work from, the calendar, in place of "This page could not be found" (the owners' decision of 2026-11-27; the
  // preview test of 2026-11-21, point 7). Anyone else gets "not found", as on every page of the owners.
  const user = await requireUser("/admin");
  if (user.role === "manager" || user.role === "staff") redirect("/admin/calendar");
  if (user.role !== "owner") notFound();
  const db = await getDb();
  const now = new Date();
  const today = localDateOf(now);
  const processor = resolvePayments().provider?.name ?? null;
  const [upcoming, todays, problems, owed, otherMoney, lastRun] = await Promise.all([
    countUpcoming(db, now),
    listBookings(db, { from: today, to: today }),
    listRefundProblems(db),
    // Paid for more than they cost, after a move or a change by the studio (the owners' decision of 2026-11-27).
    listRefundsOwed(db),
    // Bookings of the other kind of money, written by a server of the other mode since this one started.
    otherMoneyNotice(db, processor),
    schedulerLastRun(db),
  ]);
  // The scheduler is the host's to call. A site that never had one is told so in production only: in development
  // nothing calls it. One that ran and stopped is told so everywhere.
  const scheduler = schedulerState(lastRun, now);
  const schedulerProblem = lastRun
    ? scheduler.fresh
      ? null
      : `The scheduled tasks last ran ${formatInstant(lastRun)}, more than ${SCHEDULER_STALE_MINUTES} minutes ago. Until they run again, free hours, review requests, refund retries and emails wait. Check the host's scheduler.`
    : process.env.NODE_ENV === "production"
      ? "The scheduled tasks have never run. The host's scheduler must call /api/cron/tick every few minutes: until it does, free hours, review requests, refund retries and emails wait."
      : null;
  const { mode: payments, problem: paymentsProblem } = resolvePayments().client;
  const sandbox = processor === "square-sandbox";
  const email = resolveEmailTransport()?.name ?? null;

  return (
    <AdminFrame active="/admin" title="Overview" query={await searchParams}>
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-value">{todays.length}</div>
          <div className="stat-label">
            Bookings today · <Link href={`/staff?date=${today}`}>day sheet</Link>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{upcoming}</div>
          <div className="stat-label">
            Upcoming bookings · <Link href="/admin/bookings">list</Link>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{problems.length}</div>
          <div className="stat-label">Refunds not yet through</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{owed.length}</div>
          <div className="stat-label">Refunds to make</div>
        </div>
      </div>

      {otherMoney && (
        <div className="admin-card">
          <h3>Test money and real money</h3>
          <p style={{ margin: 0 }}>{otherMoney}</p>
        </div>
      )}

      {(payments !== "square" || sandbox || email !== "resend" || schedulerProblem) && (
        <div className="admin-card">
          <h3>Set-up still needed</h3>
          <ul style={{ margin: 0 }}>
            {payments === "mock" && <li>Card payments are in test mode: no card is charged. Add the Square credentials to take real payments.</li>}
            {sandbox && (
              <li>
                Card payments go to Square&apos;s sandbox: no real card is charged. Set the live account&apos;s credentials to take
                real payments.
              </li>
            )}
            {payments === "disabled" && (
              <li>{paymentsProblem ?? "No card processor is configured, so paid bookings are refused. Add the Square credentials."}</li>
            )}
            {email === "log" && <li>Emails are written to the server log instead of being sent. Add an email service to send them.</li>}
            {email === null && <li>No email service is configured, so emails (including sign-in codes) wait unsent.</li>}
            {schedulerProblem && <li>{schedulerProblem}</li>}
          </ul>
        </div>
      )}

      {owed.length > 0 && (
        <div className="admin-card" id="refunds-to-make">
          <h3>Refunds to make</h3>
          <p style={{ fontSize: ".875rem" }}>
            Each of these bookings was paid for more than it costs now, after the studio moved or changed it, and the client was told by email
            that the difference will be refunded. Nothing refunds it by itself: open the appointment and refund it under Payment,
            &ldquo;Refund the remaining credit&rdquo;. It leaves this list once it is refunded.
          </p>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Booking</th>
                  <th>Customer</th>
                  <th>Appointment</th>
                  <th>To refund</th>
                </tr>
              </thead>
              <tbody>
                {owed.map((row) => (
                  <tr key={row.ref}>
                    <td>
                      <Link href={`/admin/appointments/${row.ref}#payment`}>{row.ref}</Link>
                    </td>
                    <td>{row.customerName}</td>
                    <td>{formatInstant(row.startAt)}</td>
                    <td>{formatCents(row.cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {problems.length > 0 && (
        <div className="admin-card">
          <h3>Refunds that need attention</h3>
          <p style={{ fontSize: ".875rem" }}>
            One that failed, or was never sent, is tried again automatically. One whose reason says it waits for a card
            processor cannot be sent with the one set up now: it is sent once that processor is set up. If one keeps
            failing, refund the payment in Square, then record it here: the site then stops trying, and the
            client&rsquo;s receipt shows the refund.
          </p>
          <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Booking</th>
                <th>Customer</th>
                <th>Amount</th>
                <th>State</th>
                <th>Reason</th>
                <th>Made in Square?</th>
              </tr>
            </thead>
            <tbody>
              {problems.map((p) => (
                <tr key={p.refundId}>
                  <td>{p.ref}</td>
                  <td>{p.customerName}</td>
                  <td>{formatCents(p.amountCents)}</td>
                  <td>{p.status === "failed" ? "Failed" : "Waiting"}</td>
                  <td>{p.error ?? ""}</td>
                  <td>
                    {p.status === "failed" && (
                      <details>
                        <summary style={{ cursor: "pointer" }}>Refunded it in Square</summary>
                        <form action={recordRefundMadeInSquareAction} style={{ marginTop: ".5rem" }}>
                          <input type="hidden" name="refundId" value={p.refundId} />
                          <p style={{ fontSize: ".8rem", margin: "0 0 .4rem" }}>Only once the money was sent back in Square.</p>
                          <button type="submit" className="btn btn-dark btn-small">
                            Yes, I refunded {formatCents(p.amountCents)} in Square
                          </button>
                        </form>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </AdminFrame>
  );
}
