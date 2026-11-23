import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/domain/pricing";
import { listAddons } from "@/server/admin";
import { loadCatalog } from "@/server/catalog";
import { upcomingReservations } from "@/server/props";
import { requireOwner } from "@/server/session";
import { formatRange } from "@/server/tz";
import { AdminFrame, AdminLoading } from "../frame";

export const metadata: Metadata = { title: "Props & Resources", robots: { index: false } };

export default function PropsPage(props: PageProps<"/admin/props">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Props searchParams={props.searchParams} />
    </Suspense>
  );
}

/**
 * Props & Resources (the owner's admin brief of 2026-11-22, item 10): the add-ons that are things in a limited number,
 * how many there are, and who has them reserved, from now on. They are added and changed with the other add-ons, under
 * Studios & add-ons ("How many there are"). Overlapping bookings never hold more of one than there are
 * (src/server/props.ts).
 */
async function Props({ searchParams }: Pick<PageProps<"/admin/props">, "searchParams">) {
  await connection();
  await requireOwner("/admin/props");
  const db = await getDb();
  const now = new Date();
  const [catalog, all, reservations] = await Promise.all([loadCatalog(db), listAddons(db), upcomingReservations(db, now)]);
  const props = all.filter((addon) => addon.stock !== null && addon.stock !== undefined);
  const studioName = (id: string | null) => (id ? (catalog.studios.find((studio) => studio.id === id)?.name ?? "A studio taken off") : "Any booking");

  return (
    <AdminFrame active="/admin/props" title="Props & Resources" query={await searchParams}>
      <div className="admin-card">
        <p style={{ fontSize: ".9rem", marginBottom: 0 }}>
          A prop is an add-on in a limited number, such as one pair of angel wings: bookings at the same time share them, and none can be added to a
          booking once all are reserved for that time. A prop is reserved for the whole appointment. Add one, change its price or how many there are, or
          take it off for a while, under <Link href="/admin/studios#addons">Studios &amp; add-ons</Link>: &ldquo;How many there are&rdquo;.
        </p>
      </div>
      {props.length === 0 ? (
        <div className="admin-card">
          <p>No add-on has a number set yet.</p>
        </div>
      ) : (
        props.map((prop) => {
          const upcoming = reservations.get(prop.id) ?? [];
          return (
            <div className="admin-card" key={prop.id} id={`prop-${prop.slug}`}>
              <h3>{prop.name}</h3>
              <dl className="detail-list">
                <dt>How many there are</dt>
                <dd>{prop.stock}</dd>
                <dt>Price</dt>
                <dd>{formatCents(prop.priceCents)}</dd>
                <dt>Offered with</dt>
                <dd>{studioName(prop.studioId)}</dd>
                <dt>Status</dt>
                <dd>{prop.active ? "Offered" : "Taken off: not offered for now"}</dd>
              </dl>
              {prop.description && <p style={{ fontSize: ".875rem" }}>{prop.description}</p>}
              <h4>Reserved from now on</h4>
              {upcoming.length === 0 ? (
                <p>Not reserved.</p>
              ) : (
                <div className="data-table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Client</th>
                        <th>How many</th>
                      </tr>
                    </thead>
                    <tbody>
                      {upcoming.map((reservation) => {
                        const when = formatRange(new Date(reservation.startAt), new Date(reservation.endAt));
                        return (
                          <tr key={reservation.ref}>
                            <td>
                              {when.day}, {when.time}
                            </td>
                            <td>
                              <Link href={`/admin/appointments/${reservation.ref}`}>{reservation.customerName}</Link>
                            </td>
                            <td>{reservation.quantity}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })
      )}
    </AdminFrame>
  );
}
