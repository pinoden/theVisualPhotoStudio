import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { count } from "@/lib/words";
import { listCustomers } from "@/server/customers";
import { requireOwner } from "@/server/session";
import { formatDay } from "@/server/tz";
import { AdminFrame, AdminLoading } from "../frame";

export const metadata: Metadata = { title: "Customers", robots: { index: false } };

export default function CustomersPage(props: PageProps<"/admin/customers">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Customers searchParams={props.searchParams} />
    </Suspense>
  );
}

/** Everyone who has booked, newest booking first, with a search by name or email. Owners only. */
async function Customers({ searchParams }: Pick<PageProps<"/admin/customers">, "searchParams">) {
  await connection();
  const owner = await requireOwner("/admin/customers");
  const query = await searchParams;
  const q = typeof query.q === "string" ? query.q.trim().slice(0, 100) : "";
  const customers = await listCustomers(await getDb(), owner, { q, now: new Date() });
  if (!customers) notFound();

  return (
    <AdminFrame active="/admin/customers" title="Customers" query={query}>
      <form method="get" className="admin-form-row">
        <div className="form-group" style={{ flex: "1 1 14rem" }}>
          <label className="form-label" htmlFor="customer-search">
            Name or email
          </label>
          <input id="customer-search" name="q" className="form-control" defaultValue={q} maxLength={100} autoComplete="off" />
        </div>
        <button type="submit" className="btn btn-dark btn-small">
          Search
        </button>
        {q && (
          <Link href="/admin/customers" className="btn btn-outline btn-small">
            Show everyone
          </Link>
        )}
      </form>

      {customers.length === 0 ? (
        <div className="admin-card">{q ? `No customer matches "${q}".` : "Nobody has booked yet."}</div>
      ) : (
        <>
          <p style={{ fontSize: ".85rem" }}>
            {count(customers.length, "customer")}
            {q ? ` for "${q}"` : ""}, newest booking first.
          </p>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Bookings</th>
                  <th>Last visit</th>
                  <th>Next booking</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr key={customer.email}>
                    <td>
                      <Link href={`/admin/customers/${encodeURIComponent(customer.email)}`}>
                        <strong>{customer.name || customer.email}</strong>
                      </Link>
                      <br />
                      {customer.email}
                      {customer.phone && (
                        <>
                          <br />
                          {customer.phone}
                        </>
                      )}
                      {!customer.hasAccount && <div style={{ fontSize: ".8rem" }}>Has never signed in</div>}
                    </td>
                    <td>{customer.bookings}</td>
                    <td>{customer.lastVisit ? formatDay(new Date(customer.lastVisit)) : "None yet"}</td>
                    <td>{customer.nextVisit ? formatDay(new Date(customer.nextVisit)) : "None"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </AdminFrame>
  );
}
