import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { hoursText, type AppointmentLook } from "@/lib/domain/appointment-look";
import { LABEL_MEANING } from "@/lib/domain/labels";
import { formatCents } from "@/lib/domain/pricing";
import { longDateLabel } from "@/lib/domain/time";
import type { Appointment, moveOptions } from "@/server/appointments";
import { BY_CUSTOMER, BY_SYSTEM } from "@/server/history";
import { formatInstant, formatRange, localDateOf } from "@/server/tz";
import { MoveToNewTime } from "../appointments/MoveToNewTime";
import { CloseOnEscape } from "./CloseOnEscape";

/** "Jane Smith" as a first and a last name: the last name is what follows the first space. */
function nameParts(name: string): { first: string; last: string } {
  const [first, ...rest] = name.trim().split(/\s+/);
  return { first: first ?? "", last: rest.join(" ") };
}

const who = (actor: string) => (actor === BY_CUSTOMER ? "the client" : actor === BY_SYSTEM ? "the site" : actor);

/**
 * An appointment over the calendar, in place of a page of its own (the owner's admin brief of 2026-11-22, items 5, 7
 * and 8): everything about it, and at its top the three things done most often. It is part of the calendar's page
 * (`?open=<ref>`), so the calendar stays behind it, and closing it is a link back to the calendar as it was.
 * "Reschedule" moves it here (`&move=<date>`), with the appointment's page's own form; the appointment's page keeps
 * every other form, and "Edit" leads there.
 */
export function AppointmentDialog({
  appointment,
  look,
  closeHref,
  bookAnotherHref,
  rescheduleHref,
  move,
  today,
}: {
  appointment: Appointment;
  look: AppointmentLook;
  closeHref: string;
  /** Null when the viewer may not make bookings, or not see the client's details to fill them in. */
  bookAnotherHref: string | null;
  /** The pop-up with rescheduling open on the appointment's own day. */
  rescheduleHref: string;
  /** Rescheduling, when it is open: the date chosen and its free times, where its forms go, and how to close it. */
  move: {
    date: string | null;
    times: Awaited<ReturnType<typeof moveOptions>> | null;
    dateForm: { action: string; keep: Record<string, string> };
    back: string;
    closeHref: string;
  } | null;
  today: string;
}) {
  const when = formatRange(new Date(appointment.startAt), new Date(appointment.endAt));
  const day = localDateOf(new Date(appointment.startAt));
  const { first, last } = nameParts(appointment.customerName);
  const made = appointment.history.find((event) => event.from === "new");
  const money = appointment.money;
  const payments = appointment.payments;
  const lines = payments?.payments.filter((payment) => !payment.voided && !payment.held) ?? [];
  const refunded = lines.reduce((sum, payment) => sum + payment.refundedCents, 0);
  const page = `/admin/appointments/${encodeURIComponent(appointment.ref)}`;

  return (
    <div className="appt-dialog-backdrop">
      <CloseOnEscape href={closeHref} />
      <dialog open className="appt-dialog appt-look" aria-labelledby="appt-dialog-title" style={{ "--studio": look.color } as CSSProperties}>
        <div className="appt-dialog-actions">
          {bookAnotherHref && (
            <Link href={bookAnotherHref} className="btn btn-dark btn-small">
              Book Another Appointment
            </Link>
          )}
          <Link href={page} className="btn btn-outline btn-small">
            Edit
          </Link>
          {appointment.may.move && !move && (
            <Link href={rescheduleHref} scroll={false} className="btn btn-outline btn-small">
              Reschedule
            </Link>
          )}
          <Link href={closeHref} scroll={false} className="appt-dialog-close" aria-label="Close">
            ×
          </Link>
        </div>

        <h2 id="appt-dialog-title" tabIndex={-1} autoFocus>
          {appointment.customerName} <StatusBadge label={appointment.label} />
        </h2>
        <p className="appt-dialog-what">
          <span className="cal-swatch" aria-hidden="true" /> {look.name} · {hoursText(appointment.durationMinutes)} · {when.day}, {when.time}
        </p>

        {move && (
          <section aria-labelledby="appt-dialog-move" className="appt-dialog-move">
            <h3 id="appt-dialog-move">Reschedule</h3>
            <MoveToNewTime
              appointment={appointment}
              moveDate={move.date}
              moveTimes={move.times}
              dateForm={move.dateForm}
              back={move.back}
              today={today}
              idPrefix="appt-move"
            />
            <p style={{ margin: ".75rem 0 0" }}>
              <Link href={move.closeHref} scroll={false}>
                Keep the time it has
              </Link>
            </p>
          </section>
        )}

        <section aria-labelledby="appt-dialog-client">
          <h3 id="appt-dialog-client">Client</h3>
          <dl className="detail-list">
            <dt>First name</dt>
            <dd>{first}</dd>
            <dt>Last name</dt>
            <dd>{last || "—"}</dd>
            {appointment.customerEmail !== null && (
              <>
                <dt>Email</dt>
                <dd>
                  <a href={`mailto:${appointment.customerEmail}`}>{appointment.customerEmail}</a>
                </dd>
                <dt>Phone</dt>
                <dd>{appointment.customerPhone ? <a href={`tel:${appointment.customerPhone}`}>{appointment.customerPhone}</a> : "—"}</dd>
              </>
            )}
          </dl>
        </section>

        <section aria-labelledby="appt-dialog-appointment">
          <h3 id="appt-dialog-appointment">Appointment</h3>
          <dl className="detail-list">
            <dt>Studio</dt>
            <dd>
              {appointment.studios.join(" + ")}
              {look.bundle && ` (${look.name})`}
            </dd>
            <dt>Type</dt>
            <dd>{appointment.photography ? `Photography session: ${appointment.photography.includes}` : look.bundle ? "Studio bundle rental" : "Studio rental"}</dd>
            <dt>Date</dt>
            <dd>{longDateLabel(day)}</dd>
            <dt>Time</dt>
            <dd>{when.time}</dd>
            <dt>Length</dt>
            <dd>{hoursText(appointment.durationMinutes)}</dd>
            <dt>Add-ons and extra guests</dt>
            <dd>{appointment.addons.length === 0 ? "None" : appointment.addons.map((addon) => (addon.quantity > 1 ? `${addon.name} × ${addon.quantity}` : addon.name)).join(", ")}</dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge label={appointment.label} /> {appointment.label === "cancelled" ? "Cancelled." : LABEL_MEANING[appointment.label]}
            </dd>
            <dt>Booked</dt>
            <dd>{made ? `${formatInstant(new Date(made.at))}, by ${who(made.actor)}` : "—"}</dd>
          </dl>
        </section>

        <section aria-labelledby="appt-dialog-payment">
          <h3 id="appt-dialog-payment">Payment</h3>
          {money === null || payments === null ? (
            <p>Prices and payments are not shown at your level.</p>
          ) : (
            <dl className="detail-list">
              <dt>Appointment price</dt>
              <dd>{formatCents(money.totalCents - money.chargesCents)}</dd>
              {money.charges.length > 0 && (
                <>
                  <dt>Extra charges</dt>
                  <dd>{money.charges.map((charge) => `${charge.label} ${formatCents(charge.cents)}`).join(", ")}</dd>
                </>
              )}
              <dt>Paid</dt>
              <dd>{formatCents(payments.paidCents)}</dd>
              {lines.map((payment) => (
                <PaymentRow key={payment.id} payment={payment} receipt={`${page}/receipt/${payment.id}`} />
              ))}
              {refunded > 0 && (
                <>
                  <dt>Refunded</dt>
                  <dd>{formatCents(refunded)}</dd>
                </>
              )}
              <dt>{payments.creditLeftCents > 0 ? "Credit left" : "Still to pay"}</dt>
              <dd>{formatCents(payments.creditLeftCents > 0 ? payments.creditLeftCents : payments.dueCents)}</dd>
            </dl>
          )}
        </section>

        <section aria-labelledby="appt-dialog-notes">
          <h3 id="appt-dialog-notes">Notes</h3>
          <p className="appt-dialog-notes">{appointment.notes || "None."}</p>
        </section>

        <section aria-labelledby="appt-dialog-forms">
          <h3 id="appt-dialog-forms">Forms &amp; Agreements</h3>
          {appointment.forms.acceptances.length === 0 && appointment.forms.answers.length === 0 ? (
            <p>
              {appointment.termsAcceptedAt
                ? `The client ticked the studio policies on ${formatInstant(new Date(appointment.termsAcceptedAt))}, booking online.`
                : "Booked by the studio: the client accepted nothing online."}
            </p>
          ) : (
            <dl className="detail-list">
              {appointment.forms.acceptances.map((acceptance) => (
                <FormLine key={acceptance.id} term={acceptance.title}>
                  Version {acceptance.versionNumber}, accepted {formatInstant(new Date(acceptance.acceptedAt))} (
                  <Link href={`${page}/accepted/${acceptance.id}`}>read it</Link>)
                </FormLine>
              ))}
              {appointment.forms.answers.map((answer, index) => (
                <FormLine key={index} term={answer.label}>
                  {answer.answer}
                </FormLine>
              ))}
            </dl>
          )}
        </section>

        <p className="appt-dialog-full">
          <Link href={page}>Open the appointment&rsquo;s page</Link>: labels, payments, charges, moving and its history.
        </p>
      </dialog>
    </div>
  );
}

/** One payment: its date, how it was paid, the amount and what was refunded of it, and Square's receipt for a card. */
function PaymentRow({ payment, receipt }: { payment: NonNullable<Appointment["payments"]>["payments"][number]; receipt: string }) {
  const square = payment.processor === "square" || payment.processor === "square-sandbox";
  return (
    <>
      <dt>Payment date</dt>
      <dd>
        {formatInstant(new Date(payment.at))}: {formatCents(payment.amountCents)}, {payment.how}
        {payment.refundedCents > 0 && `, ${formatCents(payment.refundedCents)} refunded`}
        {square && (
          <>
            {" "}
            (
            <a href={receipt} target="_blank" rel="noopener noreferrer">
              Square&rsquo;s receipt
            </a>
            )
          </>
        )}
      </dd>
    </>
  );
}

function FormLine({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </>
  );
}
