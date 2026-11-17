import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { statusLabel } from "@/components/BookingSummary";
import { StatusBadge } from "@/components/StatusBadge";
import { getDb } from "@/db/client";
import { can } from "@/lib/abilities";
import { formatCents } from "@/lib/domain/pricing";
import { addDays, isIsoDate } from "@/lib/domain/time";
import { centsToInput, MONEY_FIELD } from "@/lib/parse";
import { notFound } from "next/navigation";
import { listBookings } from "@/server/admin";
import { requireManager } from "@/server/session";
import { loadSettings } from "@/server/settings";
import { formatRange, localDateOf } from "@/server/tz";
import { ownerCancelAction, ownerRefundAction } from "../actions";
import { AdminFrame, AdminLoading } from "../frame";

export const metadata: Metadata = { title: "Bookings", robots: { index: false } };

export default function BookingsPage(props: PageProps<"/admin/bookings">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Bookings searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Bookings({ searchParams }: Pick<PageProps<"/admin/bookings">, "searchParams">) {
  await connection();
  // The list is where a booking is cancelled and a card refunded: for the owners, and for a manager the owners let refund.
  const viewer = await requireManager("/admin/bookings");
  const db = await getDb();
  const settings = await loadSettings(db);
  if (!can(viewer, "refund", settings)) notFound();
  const query = await searchParams;
  const today = localDateOf(new Date());
  const from = typeof query.from === "string" && isIsoDate(query.from) ? query.from : today;
  const to = typeof query.to === "string" && isIsoDate(query.to) && query.to >= from ? query.to : addDays(from, 14);
  const includeCancelled = query.cancelled === "1";
  const bookings = await listBookings(db, { from, to }, { includeCancelled });
  const back = `/admin/bookings?from=${from}&to=${to}${includeCancelled ? "&cancelled=1" : ""}`;

  return (
    <AdminFrame active="/admin/bookings" title="Bookings" query={query} viewer={viewer} settings={settings}>
      <form method="get" className="admin-form-row">
        <div className="form-group">
          <label className="form-label" htmlFor="from">
            From
          </label>
          <input id="from" type="date" name="from" className="form-control" defaultValue={from} />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="to">
            To
          </label>
          <input id="to" type="date" name="to" className="form-control" defaultValue={to} />
        </div>
        <label style={{ fontSize: ".875rem" }}>
          <input type="checkbox" name="cancelled" value="1" defaultChecked={includeCancelled} /> Show cancelled
        </label>
        <button type="submit" className="btn btn-dark btn-small">
          Show
        </button>
      </form>

      {bookings.length === 0 ? (
        <div className="admin-card">No bookings in this period.</div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Studio</th>
                <th>Customer</th>
                <th>Total</th>
                <th>On card</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {bookings.map((b) => {
                const when = formatRange(new Date(b.startAt), new Date(b.endAt));
                const active = b.status !== "cancelled";
                return (
                  <tr key={b.ref}>
                    <td>
                      {when.day}
                      <br />
                      {when.time}
                    </td>
                    <td>
                      {b.studios.map((s) => s.name).join(" + ")}
                      {b.addons.map((a, index) => (
                        <div key={index} style={{ fontSize: ".8rem" }}>
                          + {a.name}
                        </div>
                      ))}
                    </td>
                    <td>
                      <Link href={`/admin/appointments/${b.ref}`}>
                        <strong>{b.customerName}</strong>
                      </Link>
                      <br />
                      {b.customerEmail}
                      <br />
                      {b.customerPhone}
                      {b.notes && <div style={{ fontStyle: "italic", fontSize: ".8rem" }}>{b.notes}</div>}
                      <div style={{ fontSize: ".8rem" }}>{b.ref}</div>
                    </td>
                    <td>
                      {formatCents(b.totalCents)}
                      {b.creditAppliedCents > 0 && (
                        <div style={{ fontSize: ".8rem" }}>+ {formatCents(b.creditAppliedCents)} credit</div>
                      )}
                    </td>
                    <td>
                      {formatCents(b.cardHeldCents)}
                      {b.refundProblem && <div className="badge badge-cancelled">refund failed</div>}
                    </td>
                    <td>
                      <StatusBadge label={b.label} />
                      {b.status === "cancelled" && b.cancelReason === "rescheduled" && (
                        <div style={{ fontSize: ".8rem" }}>{statusLabel(b)}</div>
                      )}
                      {b.rescheduledCount > 0 && <div style={{ fontSize: ".8rem" }}>moved, not refundable</div>}
                    </td>
                    <td>
                      {active && (
                        <details>
                          <summary style={{ cursor: "pointer" }}>Cancel</summary>
                          <form action={ownerCancelAction} style={{ marginTop: ".5rem" }}>
                            <input type="hidden" name="ref" value={b.ref} />
                            <input type="hidden" name="back" value={back} />
                            <label style={{ fontSize: ".8rem" }}>
                              Refund to card ($)
                              <br />
                              <input name="refund" className="price-input" defaultValue={centsToInput(b.refundableCents)} {...MONEY_FIELD} />
                            </label>
                            {b.refundableCents < b.cardHeldCents && (
                              <div style={{ fontSize: ".75rem", maxWidth: "12rem" }}>
                                The pet fee was already returned as studio credit, so it is not refunded to the card.
                              </div>
                            )}
                            {b.studioHeldCents > 0 && (
                              <div style={{ fontSize: ".75rem", maxWidth: "12rem" }}>
                                {formatCents(b.studioHeldCents)} of what was paid at the studio can be given back. It cannot be refunded from here:
                                give back what is owed by hand, then record it on the appointment&apos;s page.
                              </div>
                            )}
                            <br />
                            <button type="submit" className="btn btn-dark btn-small" style={{ marginTop: ".4rem" }}>
                              Cancel booking
                            </button>
                          </form>
                        </details>
                      )}
                      {b.cardHeldCents > 0 && (
                        <details>
                          <summary style={{ cursor: "pointer" }}>Refund</summary>
                          <form action={ownerRefundAction} style={{ marginTop: ".5rem" }}>
                            <input type="hidden" name="ref" value={b.ref} />
                            <input type="hidden" name="back" value={back} />
                            {b.rescheduleCode && (
                              <div style={{ fontSize: ".75rem", maxWidth: "12rem", marginBottom: ".4rem" }}>
                                Its money is on the reschedule code {b.rescheduleCode.code}, which has {formatCents(b.rescheduleCode.valueCents)} left: a
                                refund comes off the code, up to that.
                              </div>
                            )}
                            <label style={{ fontSize: ".8rem" }}>
                              Amount ($)
                              <br />
                              <input name="amount" className="price-input" {...MONEY_FIELD} required />
                            </label>
                            <br />
                            <label style={{ fontSize: ".8rem" }}>
                              Reason
                              <br />
                              <input name="reason" className="price-input" style={{ width: "11rem" }} maxLength={180} />
                            </label>
                            <br />
                            <button type="submit" className="btn btn-outline btn-small" style={{ marginTop: ".4rem" }}>
                              Send refund
                            </button>
                          </form>
                        </details>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </AdminFrame>
  );
}
