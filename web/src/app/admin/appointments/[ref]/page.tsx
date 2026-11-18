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
import { centsToInput, CHARGE_FIELD, MONEY_FIELD } from "@/lib/parse";
import { PAYMENT_METHODS } from "@/lib/payment-methods";
import { hoursInWords } from "@/lib/words";
import { getAppointment, moveOptions } from "@/server/appointments";
import { CHARGE_NOTE_MAX, OVERTIME_MAX_MINUTES, overtimeBlocks, overtimeCents } from "@/server/charges";
import { BY_CUSTOMER, BY_SYSTEM } from "@/server/history";
import { resolvePayments } from "@/server/payments";
import { requireStaff } from "@/server/session";
import { loadSettings } from "@/server/settings";
import { moneyKindOf, payLinkPossible } from "@/server/test-mode";
import { formatInstant, formatRange, localDateOf } from "@/server/tz";
import { AdminFrame, AdminLoading } from "../../frame";
import {
  addChargeAction,
  cancelPayLinkAction,
  checkPayLinkAction,
  closePayLinkByHandAction,
  handRefundAction,
  moveBookingAction,
  recordPaymentAction,
  sendPayLinkAction,
  setLabelAction,
  voidChargeAction,
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
 * One appointment, for every level of the admin. `getAppointment` decides
 * what this viewer sees: an attendant gets "not found" for a day that is not
 * theirs, and nobody below an owner sees prices unless the owners allow it.
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
  const [appointment, settings] = await Promise.all([getAppointment(db, viewer, ref, now), loadSettings(db)]);
  if (!appointment) notFound();
  const query = await searchParams;
  // "Move to a new time" works in two steps: choose the date, then one of the times that are free on it.
  const moveDate = appointment.may.move && typeof query.move === "string" && isIsoDate(query.move) ? query.move : null;
  const moveTimes = moveDate ? await moveOptions(db, viewer, ref, moveDate, now) : null;

  const when = formatRange(new Date(appointment.startAt), new Date(appointment.endAt));
  const day = localDateOf(new Date(appointment.startAt));
  // A payment link needs a card processor. In test mode the pretend one stands in, and says so to the client.
  const cardProcessor = resolvePayments().client.mode;
  const processorName = resolvePayments().provider?.name ?? null;
  // A link the processor set up now did not make (one of test mode, left after the real keys went in), or any link
  // while none is set up: the site can neither ask about it nor withdraw it, and its page offers nothing to pay.
  const foreignLink = appointment.payLink !== null && appointment.payLink.provider !== processorName;
  // How the booking ended, if it has: an amount its card still holds is given back, not taken.
  const ended = appointment.payments?.ended ?? null;
  // A booking of the other kind of money than this site's card processor moves: one a server in the other mode made.
  const otherMoney = processorName !== null && moneyKindOf(processorName) !== appointment.moneyKind ? appointment.moneyKind : null;
  // A payment link can be made: a card processor is set up, and it moves the booking's own kind of money (sendPayLink).
  const linkPossible = cardProcessor !== "disabled" && payLinkPossible(processorName, appointment.moneyKind);

  return (
    <AdminFrame
      active={viewer.role === "owner" ? "/admin/bookings" : "/staff"}
      title={appointment.customerName}
      query={query}
      viewer={viewer}
      settings={settings}
    >
      {otherMoney && (
        <div className="admin-card">
          <h3>{otherMoney === "test" ? "Made in test mode" : "A real booking"}</h3>
          <p style={{ margin: 0 }}>
            {otherMoney === "test"
              ? "No money moved for this booking: it is not a real one. A server in test mode is using this database beside this site, which the overview says more about. Its bookings are removed with the rest of test mode."
              : "This site is in test mode, and this booking is real: test mode must not use a database with real bookings. The overview says more."}
          </p>
        </div>
      )}
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
            {appointment.may.openCustomer && appointment.customerEmail ? (
              <Link href={`/admin/customers/${encodeURIComponent(appointment.customerEmail)}`}>{appointment.customerName}</Link>
            ) : (
              appointment.customerName
            )}
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
        {/* The terms it was made under, which a cancellation and a move follow (question 10). */}
        <details className="booking-terms" style={{ marginBottom: ".75rem" }}>
          <summary style={{ cursor: "pointer" }}>
            Terms of this booking{appointment.terms.changedSince ? ": the settings have changed since it was made" : ""}
          </summary>
          <ul style={{ fontSize: ".85rem", margin: ".5rem 0 0" }}>
            <li>
              Refunded when cancelled {hoursInWords(appointment.terms.refundWindowHours)} or more before it starts
              {appointment.terms.refundFeePercent > 0 ? `, less the ${appointment.terms.refundFeePercent}% processing fee` : ""}.
            </li>
            <li>
              {appointment.terms.maxReschedules > 0
                ? `Moved online until ${hoursInWords(appointment.terms.rescheduleCutoffHours)} before it starts: ${
                    appointment.terms.maxReschedules === 1 ? "once" : `${appointment.terms.maxReschedules} times`
                  } free${appointment.terms.rescheduleFeeCents > 0 ? `, then ${formatCents(appointment.terms.rescheduleFeeCents)} each time` : ", then no more"}.`
                : "Not moved online: moving was switched off when it was made."}
            </li>
            <li>A reschedule code or credit it gives is valid for {appointment.terms.creditValidDays} days.</li>
          </ul>
          {appointment.terms.changedSince && (
            <p style={{ fontSize: ".8rem", margin: ".5rem 0 0" }}>
              A booking keeps the terms it was made under; the settings of today apply to bookings made from now on.
            </p>
          )}
        </details>
        <p style={{ marginBottom: 0 }}>
          <Link href={`/admin/calendar?view=day&date=${day}`}>This day in the calendar</Link>
          {" · "}
          <Link href={`/staff?date=${day}`}>Day sheet</Link>
          {appointment.may.refund && (
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
              {appointment.terms.maxReschedules > 0 ? (
                <label style={{ display: "block", fontSize: ".85rem" }}>
                  <input type="checkbox" name="countsAsClientMove" defaultChecked /> The client asked for this move. It
                  counts as a reschedule of theirs: the booking is then no longer refunded automatically, as the rental
                  terms say
                  {appointment.terms.rescheduleFeeCents > 0
                    ? `, and each move beyond their ${appointment.terms.maxReschedules === 1 ? "free one" : `${appointment.terms.maxReschedules} free ones`} costs them ${formatCents(appointment.terms.rescheduleFeeCents)} online`
                    : ""}
                  . Untick it when the studio needs the change.
                </label>
              ) : (
                <p style={{ fontSize: ".85rem", margin: 0 }}>
                  Moving is switched off under Settings, so the rental terms say nothing about it: the move does not
                  count against the client, and the booking keeps its refund.
                </p>
              )}
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

      {appointment.charges && (appointment.charges.canAdd || appointment.charges.lines.length > 0) && (
        <div className="admin-card" id="charges">
          <h3>Extra charges</h3>
          {appointment.charges.lines.length > 0 && (
            <ul className="charge-list">
              {appointment.charges.lines.map((charge) => (
                <li key={charge.id}>
                  <span style={charge.voided ? { textDecoration: "line-through" } : undefined}>
                    {charge.label}: {formatCents(charge.amountCents)}
                  </span>
                  <span style={{ fontSize: ".8rem" }}>
                    {" "}
                    · {formatInstant(new Date(charge.at))}, by {charge.createdBy}
                    {charge.kind === "overtime" && charge.minutes && charge.hourlyCents
                      ? ` · ${overtimeBlocks(charge.minutes)} × 15 minutes started, each a quarter of ${formatCents(charge.hourlyCents)} an hour`
                      : ""}
                  </span>
                  {charge.note && <div style={{ fontSize: ".8rem" }}>{charge.note}</div>}
                  {charge.voided && <div style={{ fontSize: ".8rem" }}>Taken back by {charge.voidedBy}: it does not count.</div>}
                  {appointment.may.changePayments && !charge.voided && (
                    <details>
                      <summary style={{ fontSize: ".8rem", cursor: "pointer" }}>Added by mistake</summary>
                      <form action={voidChargeAction}>
                        <input type="hidden" name="ref" value={appointment.ref} />
                        <input type="hidden" name="chargeId" value={charge.id} />
                        <label className="form-label" htmlFor={`void-charge-${charge.id}`}>
                          Why it is taken back
                        </label>
                        <input id={`void-charge-${charge.id}`} name="reason" className="form-control" maxLength={CHARGE_NOTE_MAX} />
                        <button type="submit" className="btn btn-outline btn-small">
                          Take this charge back
                        </button>
                      </form>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}

          {appointment.charges.canAdd && appointment.charges.overtime && (
            <form action={addChargeAction} className="payment-form">
              <input type="hidden" name="ref" value={appointment.ref} />
              <input type="hidden" name="kind" value="overtime" />
              <h4>Overtime</h4>
              {appointment.charges.hourlyCents !== null ? (
                <>
                  <div className="admin-form-row">
                    <div className="form-group">
                      <label className="form-label" htmlFor="overtime-minutes">
                        Minutes past the end
                      </label>
                      <input
                        id="overtime-minutes"
                        name="minutes"
                        className="form-control"
                        type="number"
                        min={1}
                        max={OVERTIME_MAX_MINUTES}
                        step={1}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="overtime-note">
                        Note (optional)
                      </label>
                      <input id="overtime-note" name="note" className="form-control" maxLength={CHARGE_NOTE_MAX} />
                    </div>
                    <button type="submit" className="btn btn-dark btn-small">
                      Add overtime
                    </button>
                  </div>
                  <p style={{ fontSize: ".78rem", margin: ".5rem 0 0" }}>
                    Each 15 minutes started costs {formatCents(overtimeCents(appointment.charges.hourlyCents, 1))}, a quarter of
                    the hourly rate of {formatCents(appointment.charges.hourlyCents)}
                    {appointment.studios.length > 1 ? " (the one-hour prices of its studios for this day, added together)" : " (the studio's one-hour price for this day)"}.
                    For example, 20 minutes is {formatCents(overtimeCents(appointment.charges.hourlyCents, 20))}.
                  </p>
                </>
              ) : (
                <p className="field-error" style={{ marginBottom: 0 }}>
                  {appointment.charges.missingRate.join(" and ") || "This booking's studio"}{" "}
                  {appointment.charges.missingRate.length > 1 ? "have" : "has"} no one-hour price for this day under Prices, so
                  overtime cannot be worked out. Add the price, or add the amount below as a cleaning or damage charge.
                </p>
              )}
            </form>
          )}

          {appointment.charges.canAdd && (
            <details className="payment-form">
              <summary style={{ cursor: "pointer" }}>Cleaning or damage</summary>
              <form action={addChargeAction}>
                <input type="hidden" name="ref" value={appointment.ref} />
                <div className="admin-form-row">
                  <div className="form-group">
                    <label className="form-label" htmlFor="charge-kind">
                      Charge for
                    </label>
                    <select id="charge-kind" name="kind" className="form-control" defaultValue="cleaning" required>
                      <option value="cleaning">Cleaning</option>
                      <option value="damage">Damage</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="charge-amount">
                      Amount ($)
                    </label>
                    <input id="charge-amount" name="amount" className="form-control" required {...CHARGE_FIELD} />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="charge-note">
                      What it is for
                    </label>
                    <input id="charge-note" name="note" className="form-control" maxLength={CHARGE_NOTE_MAX} required />
                  </div>
                  <button type="submit" className="btn btn-dark btn-small">
                    Add the charge
                  </button>
                </div>
                <p style={{ fontSize: ".78rem", margin: ".5rem 0 0" }}>
                  The client sees the charge and what it is for on their receipt.
                </p>
              </form>
            </details>
          )}

          <p style={{ fontSize: ".78rem", margin: ".75rem 0 0" }}>
            A charge adds to what the booking owes: collect it below, at the studio (Mark as paid) or with a payment link.
          </p>
        </div>
      )}

      {/* Also for an open link of a booking that ended with nothing paid: an owner may have to close it by hand. */}
      {appointment.payments && (appointment.payments.payments.length > 0 || appointment.payments.dueCents > 0 || appointment.payLink) && (
        <div className="admin-card" id="payment">
          <h3>Payment</h3>
          <p>
            {appointment.payments.dueCents > 0 ? (
              <>
                <strong>{formatCents(appointment.payments.dueCents)} is still to pay.</strong>{" "}
                {appointment.payments.chargesCents > 0 &&
                appointment.payments.receivedCents >= appointment.payments.totalCents - appointment.payments.chargesCents
                  ? `That is for the extra charges: collect it at the studio${linkPossible ? ", or with a payment link" : ""}.`
                  : appointment.payments.madeInAdmin
                  ? "This booking was made in the admin, so nothing was charged online."
                  : `The amount its card held lapsed before it was taken, so the card was not charged: collect the price at the studio${linkPossible ? ", or with a payment link" : ""}.`}
              </>
            ) : appointment.payments.held && appointment.payments.ended ? (
              <>
                <strong>
                  {formatCents(appointment.payments.held.cents)} is still held on the client&rsquo;s card, not taken.
                </strong>{" "}
                The booking {appointment.payments.ended === "released" ? "was released for a reschedule code" : "was cancelled"}{" "}
                first, so it is given back to the card: by the site, or by the card processor itself on{" "}
                {formatInstant(new Date(appointment.payments.held.until))} at the latest. Nothing more is to pay.
              </>
            ) : appointment.payments.held && appointment.payments.held.provider !== processorName ? (
              <>
                <strong>{formatCents(appointment.payments.held.cents)} is held on the client&rsquo;s card, not taken yet.</strong>{" "}
                It was reserved through another card processor than the one set up now, which the site does not ask: it is
                not taken, and on {formatInstant(new Date(appointment.payments.held.until))} the card holds nothing, and the
                booking owes its price.
              </>
            ) : appointment.payments.held ? (
              <>
                <strong>{formatCents(appointment.payments.held.cents)} is held on the client&rsquo;s card, not taken yet.</strong>{" "}
                Taking it did not go through, and the site tries again by itself. If it is still not taken by{" "}
                {formatInstant(new Date(appointment.payments.held.until))}, the card holds nothing, and the booking owes its
                price: you are emailed then.
              </>
            ) : appointment.payments.ended && appointment.payments.receivedCents < appointment.payments.totalCents ? (
              <>
                <strong>Nothing more is to pay:</strong> the booking{" "}
                {appointment.payments.ended === "released" ? "was released for a reschedule code" : "was cancelled"}.
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
                        {payment.held && (
                          <div style={{ fontSize: ".8rem" }}>
                            {ended
                              ? "Not taken: the booking ended first, so it is given back to the card."
                              : "Not received yet: the card holds it until it is taken."}
                          </div>
                        )}
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
                {formatInstant(new Date(appointment.payLink.createdAt))} by {appointment.payLink.createdBy}.{" "}
                {foreignLink && processorName === null
                  ? "Card payments are not set up on the site now (see the overview), so the site can neither ask Square about this link nor withdraw it, and the page the client was sent to offers nothing to pay. A client who still has Square's page open could pay there. Once card payments are set up again, the site asks about it by itself; or look it up in Square, and an owner closes it here by hand."
                  : foreignLink
                    ? "It was made by another card processor than the one set up now (in test mode, or with Square's other account), so the site cannot ask about it, and the page the client was sent to offers nothing to pay. Look it up there: an owner then closes it here by hand, and a new one can be emailed."
                    : appointment.payments.ended
                      ? "The booking has ended, and the link is still open: it is withdrawn as soon as the card processor says it was not paid. If the processor cannot say, look the link up in Square: an owner then closes it here by hand."
                      : "It has not been paid yet."}
              </p>
              {appointment.may.recordPayment && !foreignLink && (
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
              {appointment.may.changePayments && (
                <details style={{ marginTop: ".75rem" }}>
                  <summary style={{ cursor: "pointer" }}>The card processor cannot say whether it was paid?</summary>
                  <form action={closePayLinkByHandAction}>
                    <input type="hidden" name="ref" value={appointment.ref} />
                    <p style={{ fontSize: ".8rem", margin: ".5rem 0" }}>
                      Only for a link the processor no longer knows, made with other keys or for another location. Look
                      it up in Square first; if it was not paid, delete it there, then close it here. The site then
                      stops asking about it, and a payment can be recorded by hand.
                    </p>
                    <button type="submit" className="btn btn-outline btn-small">
                      Close it by hand
                    </button>
                  </form>
                </details>
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

          {appointment.may.recordPayment && !appointment.payLink && linkPossible && (
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
              {appointment.petFee.returnedCents < appointment.petFee.cents
                ? `Of the pet fee of ${formatCents(appointment.petFee.cents)}, ${formatCents(appointment.petFee.returnedCents)} was returned to the client as studio credit, code `
                : `The pet fee of ${formatCents(appointment.petFee.cents)} was returned to the client as studio credit, code `}
              <strong>{appointment.petFee.creditCode}</strong>.
            </p>
          ) : (
            <>
              <p>
                This booking has a pet fee of {formatCents(appointment.petFee.cents)}. It is not refunded to a card. If the
                pet did not come, an owner can return it as studio credit from Codes.
              </p>
              {appointment.petFee.canReturn ? (
                <Link className="btn btn-outline btn-small" href={`/admin/codes?booking=${appointment.ref}#pet-fee-credit`}>
                  Go to Codes
                </Link>
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
