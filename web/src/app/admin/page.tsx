import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/domain/pricing";
import { countUpcoming, listBookings, listRefundProblems, listTestModeBookings } from "@/server/admin";
import { resolveEmailTransport } from "@/server/email";
import { resolvePayments } from "@/server/payments";
import { requireOwner } from "@/server/session";
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
  await requireOwner("/admin");
  const db = await getDb();
  const now = new Date();
  const today = localDateOf(now);
  const [upcoming, todays, problems, testMode] = await Promise.all([
    countUpcoming(db, now),
    listBookings(db, { from: today, to: today }),
    listRefundProblems(db),
    listTestModeBookings(db),
  ]);
  const payments = resolvePayments().client.mode;
  const sandbox = resolvePayments().provider?.name === "square-sandbox";
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
      </div>

      {(payments !== "square" || sandbox || email !== "resend") && (
        <div className="admin-card">
          <h3>Set-up still needed</h3>
          <ul style={{ margin: 0 }}>
            {payments === "mock" && <li>Card payments are in test mode: no card is charged. Add the Square credentials to take real payments.</li>}
            {sandbox && (
              <li>
                Card payments go to Square&apos;s sandbox: no real card is charged. Set the live credentials, with SQUARE_ENVIRONMENT
                set to production, to take real payments.
              </li>
            )}
            {payments === "disabled" && <li>No card processor is configured, so paid bookings are refused. Add the Square credentials.</li>}
            {email === "log" && <li>Emails are written to the server log instead of being sent. Add an email service to send them.</li>}
            {email === null && <li>No email service is configured, so emails (including sign-in codes) wait unsent.</li>}
          </ul>
        </div>
      )}

      {testMode.length > 0 && (
        <div className="admin-card">
          <h3>Bookings paid in test mode</h3>
          <p style={{ fontSize: ".875rem" }}>
            These were paid while card payments were in test mode, so nothing was received for them. Each still stands and owes
            its price: have it paid, with a payment link or at the studio, or cancel it.
          </p>
          <ul style={{ margin: 0 }}>
            {testMode.map((booking) => (
              <li key={booking.ref}>
                <Link href={`/admin/appointments/${booking.ref}`}>{booking.ref}</Link> · {booking.customerName} ·{" "}
                {formatInstant(new Date(booking.startAt))} · {formatCents(booking.dueCents)} to pay
              </li>
            ))}
          </ul>
        </div>
      )}

      {problems.length > 0 && (
        <div className="admin-card">
          <h3>Refunds that need attention</h3>
          <p style={{ fontSize: ".875rem" }}>
            These are retried automatically. If one keeps failing, refund the payment in Square, then record it here: the
            site then stops trying, and the client&rsquo;s receipt shows the refund.
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
