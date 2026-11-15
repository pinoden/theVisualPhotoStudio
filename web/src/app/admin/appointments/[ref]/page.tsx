import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { BookingSummary } from "@/components/BookingSummary";
import { StatusBadge } from "@/components/StatusBadge";
import { getDb } from "@/db/client";
import { LABEL_MEANING, LABEL_TEXT } from "@/lib/domain/labels";
import { formatCents } from "@/lib/domain/pricing";
import { durationLabel, isIsoDate, longDateLabel, minutesToLabel } from "@/lib/domain/time";
import { centsToInput, MONEY_FIELD } from "@/lib/parse";
import { PAYMENT_METHODS } from "@/lib/payment-methods";
import { getAppointment, moveOptions } from "@/server/appointments";
import { BY_CUSTOMER, BY_SYSTEM } from "@/server/history";
import { resolvePayments } from "@/server/payments";
import { requireStaff } from "@/server/session";
import { formatInstant, formatRange, localDateOf } from "@/server/tz";
import { AdminFrame, AdminLoading } from "../../frame";
import {
  cancelPayLinkAction,
  checkPayLinkAction,
  handRefundAction,
  moveBookingAction,
  petCreditAction,
  recordPaymentAction,
  sendPayLinkAction,
  setLabelAction,
  voidPaymentAction,
} from "../actions";

export const metadata: Metadata = { title: "Appointment", robots: { index: false } };

export default function AppointmentPage(props: PageProps<"/admin/appointments/[ref]">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <AppointmentDetails params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

const WHO: Record<string, string> = { [BY_CUSTOMER]: "The customer", [BY_SYSTEM]: "The site" };

/**
 * One appointment, for both levels of the admin. `getAppointment` decides
 * what this viewer sees: a member of staff gets "not found" for a day that is
 * not theirs, and no contact details or prices unless the owners allow them.
 */
async function AppointmentDetails({
  params,
  searchParams,
}: Pick<PageProps<"/admin/appointments/[ref]">, "params" | "searchParams">) {
  await connection();
  const { ref } = await params;
  const viewer = await requireStaff(`/admin/appointments/${encodeURIComponent(ref)}`);
  const db = await getDb();
  const now = new Date();
  const appointment = await getAppointment(db, viewer, ref, now);
  if (!appointment) notFound();
  const query = await searchParams;
  // "Move to a new time" works in two steps: choose the date, then one of the times that are free on it.
  const moveDate = appointment.may.move && typeof query.move === "string" && isIsoDate(query.move) ? query.move : null;
  const moveTimes = moveDate ? await moveOptions(db, viewer, ref, moveDate, now) : null;

  const when = formatRange(new Date(appointment.startAt), new Date(appointment.endAt));
  const day = localDateOf(new Date(appointment.startAt));
  // A payment link needs a card processor. In test mode the pretend one stands in, and says so to the client.
  const cardProcessor = resolvePayments().client.mode;

  return (
    <AdminFrame
      active={viewer.role === "owner" ? "/admin/bookings" : "/staff"}
      title={appointment.customerName}
      query={query}
      viewer={viewer}
    >
      <div className="admin-card">
        <h3>
          {when.day} <StatusBadge label={appointment.label} />
        </h3>
        <dl className="detail-list">
          <dt>Time</dt>
          <dd>
            {when.time} ({durationLabel(appointment.durationMinutes)})
          </dd>
          <dt>Studio</dt>
          <dd>{appointment.studios.join(" + ")}</dd>
          {appointment.photography && (
            <>
              <dt>Photography</dt>
              <dd>
                A session with the photographer, who is held for this time as well
                {appointment.photography.includes ? `. ${appointment.photography.includes}` : ""}.
              </dd>
            </>
          )}
          <dt>Client</dt>
          <dd>
            {appointment.customerName}
            {appointment.customerPhone && (
              <>
                {" · "}
                <a href={`tel:${appointment.customerPhone}`}>{appointment.customerPhone}</a>
              </>
            )}
            {appointment.customerEmail && (
              <>
                {" · "}
                <a href={`mailto:${appointment.customerEmail}`}>{appointment.customerEmail}</a>
              </>
            )}
          </dd>
          {appointment.addons.length > 0 && (
            <>
              <dt>Add-ons</dt>
              <dd>
                {appointment.addons
                  .map((addon) => `${addon.name}${addon.quantity > 1 ? ` × ${addon.quantity}` : ""}`)
                  .join(", ")}
              </dd>
            </>
          )}
          {appointment.notes && (
            <>
              <dt>Notes</dt>
              <dd style={{ whiteSpace: "pre-line" }}>{appointment.notes}</dd>
            </>
          )}
          <dt>Reference</dt>
          <dd>{appointment.ref}</dd>
        </dl>
        <p style={{ marginBottom: 0 }}>
          <Link href={`/admin/calendar?view=day&date=${day}`}>This day in the calendar</Link>
          {" · "}
          <Link href={`/staff?date=${day}`}>Day sheet</Link>
          {viewer.role === "owner" && (
            <>
              {" · "}
              <Link href="/admin/bookings">Cancel or refund in Bookings</Link>
            </>
          )}
        </p>
      </div>

      {appointment.may.setLabels && (
        <div className="admin-card">
          <h3>Status label</h3>
          <form action={setLabelAction} className="label-buttons">
            <input type="hidden" name="ref" value={appointment.ref} />
            {appointment.labelChoices.map((choice) => (
              <button
                key={choice.key}
                type="submit"
                name="label"
                value={choice.key}
                className={`btn btn-small ${choice.key === appointment.label ? "btn-dark" : "btn-outline"}`}
                disabled={!choice.allowed}
                aria-pressed={choice.key === appointment.label}
              >
                {LABEL_TEXT[choice.key]}
              </button>
            ))}
          </form>
          <ul className="label-meanings">
            {appointment.labelChoices.map((choice) => (
              <li key={choice.key}>
                <strong>{LABEL_TEXT[choice.key]}:</strong> {LABEL_MEANING[choice.key]}
                {!choice.allowed && choice.key !== appointment.label && <em> {choice.why}</em>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {appointment.may.move && (
        <div className="admin-card" id="move">
          <h3>Move to a new time</h3>
          <form method="get" action={`/admin/appointments/${appointment.ref}#move`} className="admin-form-row">
            <div className="form-group">
              <label className="form-label" htmlFor="move-date">
                New date
              </label>
              <input
                id="move-date"
                type="date"
                name="move"
                className="form-control"
                defaultValue={moveDate ?? day}
                min={localDateOf(now)}
                required
              />
            </div>
            <button type="submit" className="btn btn-outline btn-small">
              Show free times
            </button>
          </form>
          {moveDate && moveTimes && !moveTimes.ok && <p className="field-error">{moveTimes.message}</p>}
          {moveDate && moveTimes?.ok && moveTimes.starts.length === 0 && (
            <p className="field-error">
              No time is free on {longDateLabel(moveDate)} for {durationLabel(appointment.durationMinutes)} in{" "}
              {appointment.studios.join(" + ")}.
            </p>
          )}
          {moveDate && moveTimes?.ok && moveTimes.starts.length > 0 && (
            <form action={moveBookingAction}>
              <input type="hidden" name="ref" value={appointment.ref} />
              <input type="hidden" name="date" value={moveDate} />
              <div className="admin-form-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="move-time">
                    Free start times on {longDateLabel(moveDate)}
                  </label>
                  <select id="move-time" name="startMinute" className="form-control" required>
                    {moveTimes.starts.map((minute) => (
                      <option key={minute} value={minute}>
                        {minutesToLabel(minute)} – {minutesToLabel(minute + appointment.durationMinutes)}
                      </option>
                    ))}
                  </select>
                </div>
                <button type="submit" className="btn btn-dark btn-small">
                  Move booking
                </button>
              </div>
              <label style={{ display: "block", fontSize: ".85rem" }}>
                <input type="checkbox" name="countsAsClientMove" defaultChecked /> The client asked for this move. It
                counts as their one reschedule: the booking is then no longer refunded automatically, as the rental
                terms say. Untick it when the studio needs the change.
              </label>
            </form>
          )}
          <p style={{ fontSize: ".78rem", margin: ".75rem 0 0" }}>
            The studio and the length stay the same, and what was paid stays as it is. Only times that are free are
            offered: inside opening hours, and at least 15 minutes from any other appointment in the studio. The client
            is emailed the new time.
          </p>
        </div>
      )}

      {appointment.money && (
        <div className="admin-card">
          <h3>Price</h3>
          <BookingSummary booking={appointment.money} />
        </div>
      )}

      {appointment.payments && (appointment.payments.payments.length > 0 || appointment.payments.dueCents > 0) && (
        <div className="admin-card" id="payment">
          <h3>Payment</h3>
          <p>
            {appointment.payments.dueCents > 0 ? (
              <>
                <strong>{formatCents(appointment.payments.dueCents)} is still to pay.</strong> This booking was made in the admin,
                so nothing was charged online.
              </>
            ) : appointment.payments.totalCents > 0 ? (
              <strong>Paid in full.</strong>
            ) : (
              "Nothing was owed for this booking."
            )}
          </p>

          {appointment.payments.payments.length > 0 && (
            <div className="data-table-wrap">
              <table className="data-table history-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Payment</th>
                    <th>Recorded by</th>
                  </tr>
                </thead>
                <tbody>
                  {appointment.payments.payments.map((payment) => (
                    <tr key={payment.id}>
                      <td style={{ whiteSpace: "nowrap" }}>{formatInstant(new Date(payment.at))}</td>
                      <td>
                        <span style={payment.voided ? { textDecoration: "line-through" } : undefined}>
                          {formatCents(payment.amountCents)} · {payment.how}
                        </span>
                        {payment.voided && <div style={{ fontSize: ".8rem" }}>Taken back: it does not count.</div>}
                        {payment.refundedCents > 0 && (
                          <div style={{ fontSize: ".8rem" }}>{formatCents(payment.refundedCents)} given back.</div>
                        )}
                        {payment.note && <div style={{ fontSize: ".8rem" }}>{payment.note}</div>}
                        {appointment.may.changePayments && payment.byHand && !payment.voided && (
                          <div className="payment-fixes">
                            {payment.refundedCents === 0 && (
                              <details>
                                <summary>Recorded by mistake</summary>
                                <form action={voidPaymentAction}>
                                  <input type="hidden" name="ref" value={appointment.ref} />
                                  <input type="hidden" name="paymentId" value={payment.id} />
                                  <label className="form-label" htmlFor={`void-${payment.id}`}>
                                    Why it is taken back
                                  </label>
                                  <input id={`void-${payment.id}`} name="reason" className="form-control" maxLength={200} />
                                  <button type="submit" className="btn btn-outline btn-small">
                                    Take this record back
                                  </button>
                                </form>
                              </details>
                            )}
                            {payment.refundedCents < payment.amountCents && (
                              <details>
                                <summary>Record a refund given by hand</summary>
                                <form action={handRefundAction}>
                                  <input type="hidden" name="ref" value={appointment.ref} />
                                  <input type="hidden" name="paymentId" value={payment.id} />
                                  <label className="form-label" htmlFor={`refund-${payment.id}`}>
                                    Amount given back ($)
                                  </label>
                                  <input id={`refund-${payment.id}`} name="amount" className="form-control" required {...MONEY_FIELD} />
                                  <label className="form-label" htmlFor={`refund-note-${payment.id}`}>
                                    Note
                                  </label>
                                  <input id={`refund-note-${payment.id}`} name="note" className="form-control" maxLength={180} />
                                  <button type="submit" className="btn btn-outline btn-small">
                                    Record the refund
                                  </button>
                                </form>
                              </details>
                            )}
                          </div>
                        )}
                      </td>
                      <td>{payment.byHand ? payment.recordedBy : "The site"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {appointment.payLink && (
            <div className="payment-form" id="payment-link">
              <h4>Payment link</h4>
              <p>
                A link to pay {formatCents(appointment.payLink.amountCents)} by card was emailed to the client on{" "}
                {formatInstant(new Date(appointment.payLink.createdAt))} by {appointment.payLink.createdBy}. It has not been
                paid yet.
              </p>
              {appointment.may.recordPayment && (
                <>
                  <div className="link-actions">
                    <form action={checkPayLinkAction}>
                      <input type="hidden" name="ref" value={appointment.ref} />
                      <button type="submit" className="btn btn-dark btn-small">
                        Check whether it was paid
                      </button>
                    </form>
                    <form action={sendPayLinkAction}>
                      <input type="hidden" name="ref" value={appointment.ref} />
                      <button type="submit" className="btn btn-outline btn-small">
                        Email it again
                      </button>
                    </form>
                    <form action={cancelPayLinkAction}>
                      <input type="hidden" name="ref" value={appointment.ref} />
                      <button type="submit" className="btn btn-outline btn-small">
                        Cancel the link
                      </button>
                    </form>
                  </div>
                  <p style={{ fontSize: ".78rem", margin: ".5rem 0 0" }}>
                    When the client pays, the payment appears here by itself within a few minutes. To record money
                    taken at the studio instead, cancel the link first, so that the client cannot pay twice.
                  </p>
                </>
              )}
            </div>
          )}

          {appointment.may.recordPayment && !appointment.payLink && (
            <form action={recordPaymentAction} className="payment-form">
              <input type="hidden" name="ref" value={appointment.ref} />
              <h4>Mark as paid</h4>
              <div className="admin-form-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="payment-amount">
                    Amount paid ($)
                  </label>
                  <input
                    id="payment-amount"
                    name="amount"
                    className="form-control"
                    defaultValue={centsToInput(appointment.payments.dueCents)}
                    required
                    {...MONEY_FIELD}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="payment-method">
                    How it was paid
                  </label>
                  <select id="payment-method" name="method" className="form-control" required defaultValue="cash">
                    {Object.entries(PAYMENT_METHODS).map(([key, text]) => (
                      <option key={key} value={key}>
                        {text}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="payment-note">
                    Note (optional)
                  </label>
                  <input id="payment-note" name="note" className="form-control" maxLength={200} />
                </div>
                <button type="submit" className="btn btn-dark btn-small">
                  Record payment
                </button>
              </div>
              <p style={{ fontSize: ".78rem", margin: ".5rem 0 0" }}>
                This records money you took at the studio. Nothing is charged, and the client is emailed a confirmation.
                The amount can be part of what is owed.
              </p>
            </form>
          )}

          {appointment.may.recordPayment && !appointment.payLink && cardProcessor !== "disabled" && (
            <form action={sendPayLinkAction} className="payment-form">
              <input type="hidden" name="ref" value={appointment.ref} />
              <h4>Or let the client pay by card</h4>
              <button type="submit" className="btn btn-outline btn-small">
                Email a payment link for {formatCents(appointment.payments.dueCents)}
              </button>
              <p style={{ fontSize: ".78rem", margin: ".5rem 0 0" }}>
                The client is emailed a link to a card payment page
                {cardProcessor === "mock" ? " (test mode: no card processor is connected, so no card is charged)" : " run by Square"}.
                When they have paid, the payment appears here by itself.
              </p>
            </form>
          )}
        </div>
      )}

      {appointment.petFee && (
        <div className="admin-card" id="pet-fee">
          <h3>Pet fee</h3>
          {appointment.petFee.creditCode ? (
            <p style={{ marginBottom: 0 }}>
              The pet fee of {formatCents(appointment.petFee.cents)} was returned to the client as studio credit, code{" "}
              <strong>{appointment.petFee.creditCode}</strong>.
            </p>
          ) : (
            <>
              <p>
                This booking has a pet fee of {formatCents(appointment.petFee.cents)}. It is not refunded to a card. If the
                pet did not come, return it to the client as studio credit: they are emailed a code for that amount.
              </p>
              {appointment.petFee.canReturn ? (
                <form action={petCreditAction}>
                  <input type="hidden" name="ref" value={appointment.ref} />
                  <button type="submit" className="btn btn-outline btn-small">
                    The pet did not come: return the fee as credit
                  </button>
                </form>
              ) : (
                <p className="field-error" style={{ marginBottom: 0 }}>
                  {appointment.petFee.why}
                </p>
              )}
            </>
          )}
        </div>
      )}

      <div className="admin-card">
        <h3>History</h3>
        {appointment.history.length === 0 ? (
          <p style={{ marginBottom: 0 }}>No changes have been recorded for this booking.</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table history-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Change</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {appointment.history.map((event, index) => (
                  <tr key={index}>
                    <td style={{ whiteSpace: "nowrap" }}>{formatInstant(new Date(event.at))}</td>
                    <td>
                      {/* A line with the same label on both sides records something else that happened: its note says what. */}
                      {event.from === "new" ? "Booked" : event.from === event.to ? event.note : `${LABEL_TEXT[event.from]} → ${LABEL_TEXT[event.to]}`}
                      {event.note && event.from !== event.to && <div style={{ fontSize: ".8rem" }}>{event.note}</div>}
                    </td>
                    <td>{WHO[event.actor] ?? event.actor}</td>
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
