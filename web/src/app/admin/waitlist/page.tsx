import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { can } from "@/lib/abilities";
import { longDateLabel } from "@/lib/domain/time";
import { loadCatalog } from "@/server/catalog";
import { requireManager } from "@/server/session";
import { formatInstant, localDateOf } from "@/server/tz";
import { listWaitlist } from "@/server/waitlist";
import { AdminFrame, AdminLoading } from "../frame";
import { removeFromWaitlistAction } from "./actions";

export const metadata: Metadata = { title: "Waitlist", robots: { index: false } };

export default function WaitlistPage(props: PageProps<"/admin/waitlist">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Waitlist searchParams={props.searchParams} />
    </Suspense>
  );
}

/**
 * The waitlist (the owner's brief of 2026-11-22, item 4): the clients waiting for a time, the soonest day first, with
 * whether they were emailed that one opened up. A place is taken off here; it is deleted a month after its day.
 */
async function Waitlist({ searchParams }: Pick<PageProps<"/admin/waitlist">, "searchParams">) {
  await connection();
  const viewer = await requireManager("/admin/waitlist");
  const db = await getDb();
  const catalog = await loadCatalog(db);
  if (!can(viewer, "seeCustomers", catalog.settings)) notFound();
  const today = localDateOf(new Date());
  const entries = await listWaitlist(db, catalog, today);
  return (
    <AdminFrame active="/admin/waitlist" title="Waitlist" query={await searchParams} viewer={viewer} settings={catalog.settings}>
      <div className="admin-card">
        <p style={{ fontSize: ".9rem" }}>
          Clients join from the booking page when the time they want is taken. When a time that fits frees up (a cancellation, a move, a block
          removed), each is emailed once with a link to book it, by the scheduled task. Nothing is booked for them.
        </p>
        {entries.length === 0 ? (
          <p>Nobody is waiting.</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Between</th>
                  <th>What</th>
                  <th>Client</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{longDateLabel(entry.day)}</td>
                    <td>{entry.timeRange}</td>
                    <td>
                      {entry.what}, {entry.duration}
                    </td>
                    <td>
                      {entry.name}
                      <br />
                      <a href={`mailto:${entry.email}`}>{entry.email}</a>
                    </td>
                    <td>
                      {entry.removedAt
                        ? "Taken off"
                        : entry.notifiedAt
                          ? `Emailed ${formatInstant(new Date(entry.notifiedAt))}`
                          : `Waiting since ${formatInstant(new Date(entry.createdAt))}`}
                    </td>
                    <td>
                      {!entry.removedAt && (
                        <form action={removeFromWaitlistAction}>
                          <input type="hidden" name="id" value={entry.id} />
                          <button type="submit" className="btn btn-outline btn-small">
                            Take off
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdminFrame>
  );
}
