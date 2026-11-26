import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { bookableDurations, formatCents, PricingError, quote, taxLabel, taxRuleFor } from "@/lib/domain/pricing";
import { durationLabel, isIsoDate, longDateLabel } from "@/lib/domain/time";
import { can } from "@/lib/abilities";
import { extraGuestsFor, studioCombinationError } from "@/lib/catalog-view";
import { EMAIL_FIELD } from "@/lib/parse";
import { freeStartsFor } from "@/server/appointments";
import { dayTypeFor, loadCatalog } from "@/server/catalog";
import { requireStaff } from "@/server/session";
import { localDateOf } from "@/server/tz";
import { OverrideSubmit } from "@/components/OverrideSubmit";
import { startLabel } from "@/lib/start-label";
import { createAdminBookingAction, newBookingConflictsAction } from "../../appointments/actions";
import { AdminFrame, AdminLoading } from "../../frame";

export const metadata: Metadata = { title: "New booking", robots: { index: false } };

export default function NewBookingPage(props: PageProps<"/admin/calendar/new">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <NewBooking searchParams={props.searchParams} />
    </Suspense>
  );
}

/**
 * A booking made in the admin for a client. Two steps, each a plain form:
 * first what and when, then one of the start times that are really free and
 * the client's details, and the add-ons the client wants. The rules are those
 * of a booking made online, except that the notice period does not apply and
 * nothing is charged.
 */
async function NewBooking({ searchParams }: Pick<PageProps<"/admin/calendar/new">, "searchParams">) {
  await connection();
  const viewer = await requireStaff("/admin/calendar/new");
  const db = await getDb();
  const catalog = await loadCatalog(db);
  if (!can(viewer, "createBookings", catalog.settings)) notFound();

  const query = await searchParams;
  const now = new Date();
  const today = localDateOf(now);
  const asked = [query.studio].flat().filter((value): value is string => typeof value === "string");
  const studios = catalog.studios.filter((studio) => asked.includes(studio.id));
  const studioIds = studios.map((studio) => studio.id);
  const date = typeof query.date === "string" && isIsoDate(query.date) ? query.date : today;
  // A client's details, from "Book Another Appointment" on an appointment (the owner's admin brief of 2026-11-22, item
  // 5): they fill the client's fields, and are carried through the choice of studio, date and length.
  const given = (key: "clientName" | "clientEmail" | "clientPhone", max: number) => {
    const value = query[key];
    return typeof value === "string" ? value.trim().slice(0, max) : "";
  };
  const client = { name: given("clientName", 120), email: given("clientEmail", 200), phone: given("clientPhone", 40) };
  const dayType = dayTypeFor(catalog, date);
  // An owner may choose any time, over what is in its way, after a pop-up says what (question 79).
  const owner = viewer.role === "owner";
  const anyTime = owner && query.anyTime === "1";

  // The lengths on sale: for the chosen studios on that kind of day, or every length while nothing is chosen.
  const lengths =
    studioIds.length > 0
      ? bookableDurations(studioIds, dayType, catalog.rules, catalog.bundlePrices)
      : [...new Set([...catalog.rules, ...catalog.bundlePrices].map((rule) => rule.durationMinutes))].sort((a, b) => a - b);
  const duration = lengths.find((minutes) => String(minutes) === query.duration) ?? null;

  const combinationError = studioCombinationError(catalog.studios, studioIds);
  const ready = studioIds.length > 0 && duration !== null && !combinationError;
  // The add-ons the booking screen would offer for these studios: those for any booking, and those of a chosen studio.
  const addons = catalog.addons.filter((addon) => addon.studioId === null || studioIds.includes(addon.studioId));
  // Extra guests these studios can take, as the booking screen says (extraGuestsFor).
  const guestsAllowed = extraGuestsFor(catalog, studioIds);
  const guestRule =
    guestsAllowed > 0
      ? `Up to ${guestsAllowed} with ${studioIds.length > 1 ? "these studios" : "this studio"}.`
      : studioIds.length > 1
        ? `None with these studios together: ${studioIds.length === 2 ? catalog.settings.twoStudioGuestLimit : catalog.settings.threeStudioGuestLimit} guests at most in all, and their prices include that many.`
        : "None with this studio.";
  const free = ready ? await freeStartsFor(db, { studioIds, date, durationMinutes: duration, anyTime }, now) : null;
  let price: number | null = null;
  if (ready) {
    try {
      price = quote({
        studioIds,
        dayType,
        durationMinutes: duration,
        rules: catalog.rules,
        bundlePrices: catalog.bundlePrices,
        multiStudioPercent: catalog.settings.multiStudioPercent,
        tax: taxRuleFor(catalog.settings, false),
      }).totalCents;
    } catch (error) {
      if (!(error instanceof PricingError)) throw error;
    }
  }

  return (
    <AdminFrame active="/admin/calendar" title="New booking" query={query} viewer={viewer} settings={catalog.settings}>
      <p>
        <Link href={`/admin/calendar?view=day&date=${date}`}>← Back to the calendar</Link>
      </p>

      <form method="get" className="admin-card">
        <h3>1. What and when</h3>
        {client.name && (
          <p className="notice">
            Another appointment for {client.name}: their details are filled in below.
            <input type="hidden" name="clientName" value={client.name} />
            <input type="hidden" name="clientEmail" value={client.email} />
            <input type="hidden" name="clientPhone" value={client.phone} />
          </p>
        )}
        <fieldset className="admin-fieldset">
          <legend className="form-label">Studio</legend>
          {catalog.studios.map((studio) => (
            <label key={studio.id} className="admin-check">
              <input type="checkbox" name="studio" value={studio.id} defaultChecked={studioIds.includes(studio.id)} /> {studio.name}
            </label>
          ))}
        </fieldset>
        <div className="admin-form-row">
          <div className="form-group">
            <label className="form-label" htmlFor="new-date">
              Date
            </label>
            <input id="new-date" type="date" name="date" className="form-control" defaultValue={date} min={today} required />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="new-duration">
              Length
            </label>
            <select id="new-duration" name="duration" className="form-control" defaultValue={duration ?? ""} required>
              <option value="">Choose…</option>
              {lengths.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {durationLabel(minutes)}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn btn-outline btn-small">
            Show free times
          </button>
        </div>
        {owner && (
          <label className="admin-check" style={{ display: "block", fontSize: ".85rem" }}>
            <input type="checkbox" name="anyTime" value="1" defaultChecked={anyTime} /> Any time (owners only). Every start of the day is
            offered, outside the opening hours and over other bookings or blocked time too; before it is booked, a pop-up says what it passes
            over.
          </label>
        )}
        {combinationError && <p className="field-error" role="alert">{combinationError}</p>}
        {!combinationError && studioIds.length > 0 && query.duration !== undefined && duration === null && (
          <p className="field-error">That length is not sold for the chosen studios on that day. Choose another.</p>
        )}
      </form>

      {ready && free && (
        <form action={createAdminBookingAction} className="admin-card">
          <h3>2. Time and client</h3>
          <p>
            {studios.map((studio) => studio.name).join(" + ")}, {longDateLabel(date)}, {durationLabel(duration)}.
            {price !== null && (
              <>
                {" "}
                <strong>{formatCents(price)}</strong>
                {catalog.settings.salesTaxBasisPoints > 0 && ` with ${taxLabel(catalog.settings.salesTaxBasisPoints).toLowerCase()}`}
                {addons.length > 0 && ", and the add-ons ticked below,"} to be paid at the studio. Nothing is charged online.
              </>
            )}
          </p>
          {!free.ok && <p className="field-error">{free.message}</p>}
          {free.ok && free.starts.length === 0 && (
            <p className="field-error">No time is free for that on {longDateLabel(date)}. Try another day, length or studio.</p>
          )}
          {free.ok && free.starts.length > 0 && (
            <>
              {studioIds.map((id) => (
                <input key={id} type="hidden" name="studio" value={id} />
              ))}
              <input type="hidden" name="date" value={date} />
              <input type="hidden" name="duration" value={duration} />
              {anyTime && <input type="hidden" name="anyTime" value="1" />}
              <div className="admin-form-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="new-time">
                    {anyTime ? "Start times" : "Free start times"}
                  </label>
                  <select id="new-time" name="startMinute" className="form-control" required>
                    {free.starts.map((minute) => (
                      <option key={minute} value={minute}>
                        {startLabel(minute, duration, free.passes)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="admin-form-row">
                <div className="form-group" style={{ flex: "1 1 12rem" }}>
                  <label className="form-label" htmlFor="new-name">
                    Client&rsquo;s name
                  </label>
                  <input id="new-name" name="name" className="form-control" minLength={2} maxLength={120} autoComplete="off" defaultValue={client.name} required />
                </div>
                <div className="form-group" style={{ flex: "1 1 12rem" }}>
                  <label className="form-label" htmlFor="new-email">
                    Client&rsquo;s email
                  </label>
                  <input id="new-email" name="email" className="form-control" {...EMAIL_FIELD} autoComplete="off" defaultValue={client.email} required />
                </div>
                <div className="form-group" style={{ flex: "1 1 10rem" }}>
                  <label className="form-label" htmlFor="new-phone">
                    Client&rsquo;s phone
                  </label>
                  <input id="new-phone" name="phone" type="tel" className="form-control" minLength={7} maxLength={40} autoComplete="off" defaultValue={client.phone} required />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="new-notes">
                  Notes
                </label>
                <textarea id="new-notes" name="notes" className="form-control" rows={2} maxLength={2000} />
              </div>
              {addons.length > 0 && (
                <fieldset className="form-group price-summary">
                  <legend className="form-label">Add-ons</legend>
                  {addons.map((addon) =>
                    addon.maxQuantity > 1 ? (
                      // Taken in a quantity (an extra guest). How many the studios can take is checked with the price.
                      <div className="addon-row addon-quantity" key={addon.id}>
                        <input
                          id={`addon-count-${addon.id}`}
                          name={`addonCount-${addon.id}`}
                          className="form-control addon-count"
                          type="number"
                          min={0}
                          max={addon.kind === "people" ? Math.min(addon.maxQuantity, guestsAllowed) : addon.maxQuantity}
                          step={1}
                          defaultValue={0}
                        />
                        <span className="addon-text">
                          <span className="addon-head">
                            <label htmlFor={`addon-count-${addon.id}`}>
                              <strong>{addon.name}</strong>
                            </label>
                            <span className="addon-price">{formatCents(addon.priceCents)} each</span>
                          </span>
                          {addon.description && <span className="addon-description">{addon.description}</span>}
                          {addon.kind === "people" && (
                            <span className="addon-description">
                              {guestRule}
                            </span>
                          )}
                        </span>
                      </div>
                    ) : (
                    <label className="addon-row" key={addon.id}>
                      <input type="checkbox" name="addon" value={addon.id} />
                      <span className="addon-text">
                        <span className="addon-head">
                          <strong>{addon.name}</strong>
                          <span className="addon-price">{formatCents(addon.priceCents)}</span>
                        </span>
                        {addon.description && <span className="addon-description">{addon.description}</span>}
                      </span>
                    </label>
                    ),
                  )}
                </fieldset>
              )}
              <div className="form-group" style={{ maxWidth: "20rem" }}>
                <label className="form-label" htmlFor="new-code">
                  Client&rsquo;s reward, credit or membership code (optional)
                </label>
                <input id="new-code" name="code" className="form-control" maxLength={40} autoComplete="off" autoCapitalize="characters" />
                <div style={{ fontSize: ".78rem", marginTop: ".25rem" }}>
                  A free hour, studio credit or membership code that belongs to this client&rsquo;s email address. A free hour
                  and credit are used up; a membership&rsquo;s hours come off what it has left. What they pay comes off
                  what is paid at the studio.
                </div>
              </div>
              {owner ? (
                <OverrideSubmit check={newBookingConflictsAction} className="btn btn-dark">
                  Book for the client
                </OverrideSubmit>
              ) : (
                <button type="submit" className="btn btn-dark">
                  Book for the client
                </button>
              )}
              <p style={{ fontSize: ".78rem", margin: ".75rem 0 0" }}>
                The client is emailed a confirmation with their own link to the booking. The same rules apply as for a
                booking made online: opening hours, no overlap, and 15 minutes between appointments.
              </p>
            </>
          )}
        </form>
      )}
    </AdminFrame>
  );
}
