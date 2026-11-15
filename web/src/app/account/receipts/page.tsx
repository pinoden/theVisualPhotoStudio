import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { AccountFrame } from "@/components/AccountFrame";
import { getDb } from "@/db/client";
import { money } from "@/server/receipt-pdf";
import { loadReceipts, RECEIPT_STATUS_TEXT, yearsOf, yearStatement } from "@/server/receipts";
import { requireUser } from "@/server/session";
import { formatDay, formatInstant, localDateOf } from "@/server/tz";

export const metadata: Metadata = { title: "Receipts & Payments", robots: { index: false } };

export default function ReceiptsPage(props: PageProps<"/account/receipts">) {
  return (
    <>
      <div className="page-banner">
        <p className="section-eyebrow">My Account</p>
        <h1>Receipts &amp; Payments</h1>
      </div>
      <section className="section section-cream">
        <div className="container-sm">
          <Suspense fallback={<div className="spinner" />}>
            <Receipts searchParams={props.searchParams} />
          </Suspense>
        </div>
      </section>
    </>
  );
}

/**
 * Everything a customer has paid, a year at a time: the year's total, each
 * payment and refund by date, and a receipt for each booking, to view, print
 * or download. What is still to pay is listed apart: it is not a receipt.
 */
async function Receipts({ searchParams }: Pick<PageProps<"/account/receipts">, "searchParams">) {
  await connection();
  const user = await requireUser("/account/receipts");
  const query = await searchParams;
  const { receipts, unpaid } = await loadReceipts(await getDb(), user.email);
  const years = yearsOf(receipts);
  const thisYear = Number(localDateOf(new Date()).slice(0, 4));
  const asked = typeof query.year === "string" && /^\d{4}$/.test(query.year) ? Number(query.year) : null;
  const year = asked !== null && years.includes(asked) ? asked : (years[0] ?? thisYear);
  const statement = yearStatement(receipts, year);

  return (
    <AccountFrame user={user} active="/account/receipts">
      {unpaid.length > 0 && (
        <div className="admin-card">
          <h3>To pay</h3>
          <p className="account-small">These bookings have not been paid yet. They are not receipts.</p>
          <ul className="plain-list">
            {unpaid.map((booking) => (
              <li key={booking.ref}>
                <strong>{money(booking.dueCents)}</strong> for {booking.studios} on {formatInstant(new Date(booking.visitStart))} ({booking.ref}),
                to pay at the studio.
              </li>
            ))}
          </ul>
        </div>
      )}

      {receipts.length === 0 ? (
        <div className="admin-card">
          <h3>No payments yet</h3>
          <p style={{ marginBottom: 0 }}>
            When you pay for a booking, its receipt appears here. <Link href="/book">Book a studio</Link>.
          </p>
        </div>
      ) : (
        <>
          {years.length > 1 && (
            <nav className="tab-row" aria-label="Year">
              {years.map((each) => (
                <Link key={each} href={`/account/receipts?year=${each}`} aria-current={each === year ? "page" : undefined}>
                  {each}
                </Link>
              ))}
            </nav>
          )}

          <div className="admin-card">
            <h3>Your payments in {year}</h3>
            <dl className="reward-facts">
              <div>
                <dt>Paid</dt>
                <dd>{money(statement.paidCents)}</dd>
              </div>
              <div>
                <dt>Refunded</dt>
                <dd>{money(-statement.refundedCents)}</dd>
              </div>
              <div>
                <dt>Paid, less refunds</dt>
                <dd>
                  <strong>{money(statement.netCents)}</strong>
                </dd>
              </div>
            </dl>
            <p className="account-actions">
              <a href={`/account/receipts/year/${year}/pdf`} className="btn btn-dark btn-small">
                Download all {year} receipts (PDF)
              </a>
            </p>
            <p className="account-small">
              One file: a summary of the year for your bookkeeping, then the receipt of every booking you paid for or
              were refunded for in {year}.
            </p>
          </div>

          <div className="admin-card">
            <h3>Receipts</h3>
            <ul className="receipt-list">
              {statement.receipts.map((receipt) => (
                <li key={receipt.ref}>
                  <div className="receipt-row-main">
                    <strong>{formatDay(new Date(receipt.paidAt))}</strong>
                    <span>
                      {receipt.studios}, appointment {formatInstant(new Date(receipt.visitStart))}
                    </span>
                    <span className="account-small">
                      {receipt.ref} · {RECEIPT_STATUS_TEXT[receipt.status]}
                      {receipt.refundedCents > 0 && `: ${money(receipt.refundedCents)} given back`}
                    </span>
                  </div>
                  <div className="receipt-row-amount">{money(receipt.paidCents)}</div>
                  <div className="receipt-row-links">
                    <Link href={`/account/receipts/${receipt.ref}`} className="btn btn-outline btn-small">
                      View
                    </Link>
                    <a href={`/account/receipts/${receipt.ref}/pdf`} className="btn btn-outline btn-small">
                      PDF
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="admin-card">
            <h3>Payments and refunds by date</h3>
            <div className="data-table-wrap">
              <table className="data-table history-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>What</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {statement.transactions.map((transaction, index) => (
                    <tr key={index}>
                      <td style={{ whiteSpace: "nowrap" }}>{formatDay(new Date(transaction.at))}</td>
                      <td>
                        {transaction.kind === "payment" ? "Payment" : `Refund${transaction.pending ? " (on its way)" : ""}`} for {transaction.studios},{" "}
                        {transaction.ref}
                        {transaction.detail && <div style={{ fontSize: ".8rem" }}>{transaction.detail}</div>}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>{money(transaction.cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <p className="account-small">
        Credit you hold, from a booking you moved or from the studio, is not a payment: it is under{" "}
        <Link href="/account/rewards">My Rewards</Link>.
      </p>
    </AccountFrame>
  );
}
