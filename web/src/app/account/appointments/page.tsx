import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { AccountFrame } from "@/components/AccountFrame";
import { BookingSummary } from "@/components/BookingSummary";
import { ManageBooking } from "@/components/ManageBooking";
import { getDb } from "@/db/client";
import { count } from "@/lib/words";
import { customerStatus, filterPast, loadAppointments, parsePastFilter, PAST_STATUSES, studiosOf, type AccountBooking } from "@/server/account";
import { isUpcomingVisit } from "@/server/bookings";
import { endRequestText, getManageChoices } from "@/server/manage";
import { noticePaidLinksOf } from "@/server/pay-links";
import { finishAfterResponse, payLinkDeps } from "@/server/runtime";
import { requireUser } from "@/server/session";
import { loadAccessInstructions } from "@/server/settings";
import { formatRange } from "@/server/tz";

export const metadata: Metadata = { title: "My Appointments", robots: { index: false } };

export default function AppointmentsPage(props: PageProps<"/account/appointments">) {
  return (
    <>
      <div className="page-banner">
        <p className="section-eyebrow">My Account</p>
        <h1>My Appointments</h1>
      </div>
      <section className="section section-cream">
        <div className="container-sm">
          <Suspense fallback={<div className="spinner" />}>
            <Appointments searchParams={props.searchParams} />
          </Suspense>
        </div>
      </section>
    </>
  );
}

function Status({ booking }: { booking: AccountBooking }) {
  const status = customerStatus(booking);
  return <span className={`status-badge status-${status.badge}`}>{status.text}</span>;
}

/** What the studio did to the booking's time: the booking keeps its reference and its record. */
function Moves({ booking }: { booking: AccountBooking }) {
  if (booking.moves.length === 0) return null;
  return (
    <ul className="appointment-moves">
      {booking.moves.map((move, index) => (
        <li key={index}>{move} by the studio.</li>
      ))}
    </ul>
  );
}

/**
 * A customer's appointments in two tabs. Upcoming: everything still to come,
 * each with its full details and the buttons to move or cancel it within the
 * rental terms. Past: everything else, which can be narrowed by date, studio
 * and status. Each tab is an address of its own.
 */
async function Appointments({ searchParams }: Pick<PageProps<"/account/appointments">, "searchParams">) {
  await connection();
  const user = await requireUser("/account/appointments");
  const query = await searchParams;
  const db = await getDb();
  // Payment links paid that the site has not seen yet are recorded first: what the page says counts them.
  const unseenLink = await noticePaidLinksOf(db, user.email, await payLinkDeps(), finishAfterResponse);
  const now = new Date();
  const { upcoming, past } = await loadAppointments(db, user.email, now);
  const tab = query.tab === "past" ? "past" : "upcoming";

  // A cancellation or release the client asked for that waits for the card processor is said in place of its choices.
  const waiting = upcoming.map((booking) =>
    booking.endRequest ? { kind: booking.endRequest.kind, text: endRequestText({ kind: booking.endRequest.kind, at: new Date(booking.endRequest.at) }) } : null,
  );
  const choices =
    tab === "upcoming"
      ? await Promise.all(
          upcoming.map((booking, index) => (waiting[index] ? null : getManageChoices(db, booking.ref, { kind: "customer", email: user.email }, now))),
        )
      : [];
  // How to get into the building: for the holder of a confirmed booking that has not ended.
  const access = tab === "upcoming" && upcoming.some((booking) => isUpcomingVisit(booking, now)) ? await loadAccessInstructions(db) : "";
  const filter = parsePastFilter(query);
  const shown = filterPast(past, filter);
  const filtered = Object.keys(filter).length > 0;

  return (
    <AccountFrame user={user} active="/account/appointments">
      <nav className="tab-row" aria-label="Appointments">
        <Link href="/account/appointments" aria-current={tab === "upcoming" ? "page" : undefined}>
          Upcoming ({upcoming.length})
        </Link>
        <Link href="/account/appointments?tab=past" aria-current={tab === "past" ? "page" : undefined}>
          Past ({past.length})
        </Link>
      </nav>

      {tab === "upcoming" && (
        <>
          {unseenLink && upcoming.length > 0 && (
            <div className="notice">
              {unseenLink === "foreign"
                ? "The site cannot check the payment link of one of your bookings. If you paid it, please contact us: what this page says does not count that payment."
                : "We could not check just now whether a payment link of your bookings was paid, so what this page says does not count a payment made through it yet. If you paid one, please look again later."}
            </div>
          )}
          {upcoming.length === 0 && (
            <p>
              You have no upcoming appointments. <Link href="/book">Book a studio</Link>.
            </p>
          )}
          {upcoming.map((booking, index) => (
            <div className="admin-card appointment-card" key={booking.ref} id={booking.ref}>
              <h3>
                {booking.studios.map((studio) => studio.name).join(" + ")} <Status booking={booking} />{" "}
                <span className="appointment-ref">{booking.ref}</span>
              </h3>
              <BookingSummary booking={booking} />
              <Moves booking={booking} />
              {booking.label === "reschedule_pending" && (
                <div className="notice" role="status">
                  We have your request to move this booking. Your time is still held for you, and we will confirm the
                  new date and time with you.
                </div>
              )}
              {access && isUpcomingVisit(booking, now) && (
                <div className="notice" style={{ whiteSpace: "pre-line" }}>
                  <strong>Getting in</strong>
                  <br />
                  {access}
                </div>
              )}
              <ManageBooking bookingRef={booking.ref} choices={choices[index]} waiting={waiting[index]} keepInPlace />
            </div>
          ))}
        </>
      )}

      {tab === "past" && (
        <>
          <form method="get" className="admin-form-row past-filter">
            <input type="hidden" name="tab" value="past" />
            <div className="form-group">
              <label className="form-label" htmlFor="past-from">
                From
              </label>
              <input id="past-from" type="date" name="from" className="form-control" defaultValue={filter.from ?? ""} />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="past-to">
                To
              </label>
              <input id="past-to" type="date" name="to" className="form-control" defaultValue={filter.to ?? ""} />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="past-studio">
                Studio
              </label>
              <select id="past-studio" name="studio" className="form-control" defaultValue={filter.studio ?? ""}>
                <option value="">Every studio</option>
                {studiosOf(past).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="past-status">
                Status
              </label>
              <select id="past-status" name="status" className="form-control" defaultValue={filter.status ?? ""}>
                <option value="">Every status</option>
                {Object.entries(PAST_STATUSES).map(([key, text]) => (
                  <option key={key} value={key}>
                    {text}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn btn-dark btn-small">
              Show
            </button>
          </form>
          {filtered && (
            <p className="account-small">
              {count(shown.length, "appointment")} of {past.length} shown. <Link href="/account/appointments?tab=past">Show all</Link>
            </p>
          )}

          {past.length === 0 && <p>You have no past appointments yet.</p>}
          {past.length > 0 && shown.length === 0 && <p>No past appointment matches. Change the dates, the studio or the status.</p>}
          {shown.map((booking) => {
            const when = formatRange(new Date(booking.startAt), new Date(booking.endAt));
            return (
              <details className="past-item" key={booking.ref}>
                <summary>
                  <span className="past-when">
                    {when.day}, {when.time}
                  </span>
                  <span className="past-what">
                    {booking.photography && "Photography session, "}
                    {booking.studios.map((studio) => studio.name).join(" + ")}
                  </span>
                  <Status booking={booking} />
                </summary>
                <div className="past-details">
                  <p className="appointment-ref">Reference {booking.ref}</p>
                  <BookingSummary booking={booking} />
                  <Moves booking={booking} />
                </div>
              </details>
            );
          })}
        </>
      )}
    </AccountFrame>
  );
}
