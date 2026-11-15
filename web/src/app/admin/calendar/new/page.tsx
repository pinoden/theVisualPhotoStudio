import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { bookableDurations, formatCents, PricingError, quote } from "@/lib/domain/pricing";
import { durationLabel, isIsoDate, longDateLabel, minutesToLabel } from "@/lib/domain/time";
import { can } from "@/lib/staff-abilities";
import { freeStartsFor } from "@/server/appointments";
import { dayTypeFor, loadCatalog } from "@/server/catalog";
import { requireStaff } from "@/server/session";
import { localDateOf } from "@/server/tz";
import { createAdminBookingAction } from "../../appointments/actions";
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
 * the client's details. The rules are those of a booking made online, except
 * that the notice period does not apply and nothing is charged.
 */
async function NewBooking({ searchParams }: Pick<PageProps<"/admin/calendar/new">, "searchParams">) {
  await connection();
  const viewer = await requireStaff("/admin/calendar/new");
  const db = await getDb();
  const catalog = await loadCatalog(db);
  if (!can(viewer, "staffCreatesBookings", catalog.settings)) notFound();

  const query = await searchParams;
  const now = new Date();
  const today = localDateOf(now);
  const asked = [query.studio].flat().filter((value): value is string => typeof value === "string");
  const studios = catalog.studios.filter((studio) => asked.includes(studio.id));
  const studioIds = studios.map((studio) => studio.id);
  const date = typeof query.date === "string" && isIsoDate(query.date) ? query.date : today;
  const dayType = dayTypeFor(catalog, date);

  // The lengths on sale: for the chosen studios on that kind of day, or every length while nothing is chosen.
  const lengths =
    studioIds.length > 0
      ? bookableDurations(studioIds, dayType, catalog.rules)
      : [...new Set(catalog.rules.map((rule) => rule.durationMinutes))].sort((a, b) => a - b);
  const duration = lengths.find((minutes) => String(minutes) === query.duration) ?? null;

  const ready = studioIds.length > 0 && duration !== null;
  const free = ready ? await freeStartsFor(db, { studioIds, date, durationMinutes: duration }, now) : null;
  let price: number | null = null;
  if (ready) {
    try {
      price = quote({
        studioIds,
        dayType,
        durationMinutes: duration,
        rules: catalog.rules,
        multiStudioPercent: catalog.settings.multiStudioPercent,
      }).totalCents;
    } catch (error) {
      if (!(error instanceof PricingError)) throw error;
    }
  }

  return (
    <AdminFrame active="/admin/calendar" title="New booking" query={query} viewer={viewer}>
      <p>
        <Link href={`/admin/calendar?view=day&date=${date}`}>← Back to the calendar</Link>
      </p>

      <form method="get" className="admin-card">
        <h3>1. What and when</h3>
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
        {studioIds.length > 0 && query.duration !== undefined && duration === null && (
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
                <strong>{formatCents(price)}</strong>, to be paid at the studio. Nothing is charged online.
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
              <div className="admin-form-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="new-time">
                    Free start times
                  </label>
                  <select id="new-time" name="startMinute" className="form-control" required>
                    {free.starts.map((minute) => (
                      <option key={minute} value={minute}>
                        {minutesToLabel(minute)} – {minutesToLabel(minute + duration)}
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
                  <input id="new-name" name="name" className="form-control" minLength={2} maxLength={120} autoComplete="off" required />
                </div>
                <div className="form-group" style={{ flex: "1 1 12rem" }}>
                  <label className="form-label" htmlFor="new-email">
                    Client&rsquo;s email
                  </label>
                  <input id="new-email" name="email" type="email" className="form-control" maxLength={200} autoComplete="off" required />
                </div>
                <div className="form-group" style={{ flex: "1 1 10rem" }}>
                  <label className="form-label" htmlFor="new-phone">
                    Client&rsquo;s phone
                  </label>
                  <input id="new-phone" name="phone" type="tel" className="form-control" minLength={7} maxLength={40} autoComplete="off" required />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="new-notes">
                  Notes
                </label>
                <textarea id="new-notes" name="notes" className="form-control" rows={2} maxLength={2000} />
              </div>
              <button type="submit" className="btn btn-dark">
                Book for the client
              </button>
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
