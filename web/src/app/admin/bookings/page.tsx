import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { statusLabel } from "@/components/BookingSummary";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/domain/pricing";
import { addDays, isIsoDate } from "@/lib/domain/time";
import { centsToInput } from "@/lib/parse";
import { listBookings } from "@/server/admin";
import { requireOwner } from "@/server/session";
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
  await requireOwner("/admin/bookings");
  const query = await searchParams;
  const today = localDateOf(new Date());
  const from = typeof query.from === "string" && isIsoDate(query.from) ? query.from : today;
  const to = typeof query.to === "string" && isIsoDate(query.to) && query.to >= from ? query.to : addDays(from, 14);
  const includeCancelled = query.cancelled === "1";
  const bookings = await listBookings(await getDb(), { from, to }, { includeCancelled });
  const back = `/admin/bookings?from=${from}&to=${to}${includeCancelled ? "&cancelled=1" : ""}`;

  return (
    <AdminFrame active="/admin/bookings" title="Bookings" query={query}>
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
                      {b.addons.map((a) => (
                        <div key={a.name} style={{ fontSize: ".8rem" }}>
                          + {a.name}
                        </div>
                      ))}
                    </td>
                    <td>
                      <strong style={{ color: "var(--color-dark)" }}>{b.customerName}</strong>
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
                      {statusLabel(b)}
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
                              <input name="refund" className="price-input" defaultValue={centsToInput(b.cardHeldCents)} inputMode="decimal" />
                            </label>
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
                            <label style={{ fontSize: ".8rem" }}>
                              Amount ($)
                              <br />
                              <input name="amount" className="price-input" inputMode="decimal" required />
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
