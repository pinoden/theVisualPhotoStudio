import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { bundleName, bundleTables, priceTable, studioCombinationError } from "@/lib/catalog-view";
import { durationLabel, longDateLabel } from "@/lib/domain/time";
import { centsToInput, PRICE_FIELD } from "@/lib/parse";
import { loadCatalog } from "@/server/catalog";
import { requireOwner } from "@/server/session";
import { LONGEST_BOOKINGS } from "@/server/settings";
import { localDateOf } from "@/server/tz";
import { addBundleLengthAction, addDurationAction, saveLengthsAction, saveBundlePricesAction, saveDiscountAction, savePricesAction, specialDateAction } from "../actions";
import { AdminFrame, AdminLoading } from "../frame";

export const metadata: Metadata = { title: "Prices", robots: { index: false } };

export default function PricesPage(props: PageProps<"/admin/prices">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Prices searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Prices({ searchParams }: Pick<PageProps<"/admin/prices">, "searchParams">) {
  await connection();
  await requireOwner("/admin/prices");
  // Read fresh, not from the page cache: the owner must see what is stored.
  const catalog = await loadCatalog(await getDb());
  const today = localDateOf(new Date());
  const special = Object.entries(catalog.specialDates)
    .filter(([day]) => day >= today)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  // The studios that can be booked together: every two or more of them the booking screen takes, the fewest first.
  const tables = bundleTables(catalog);
  const bundles = catalog.studios
    .reduce<string[][]>((sets, studio) => [...sets, ...sets.map((set) => [...set, studio.id])], [[]])
    .filter((ids) => ids.length > 1 && !studioCombinationError(catalog.studios, ids))
    .map((ids) => ({ ids, name: bundleName(catalog, ids), prices: tables.find((table) => table.studioIds.length === ids.length && ids.every((id) => table.studioIds.includes(id)))?.prices ?? [] }))
    // As the Rates page lists them: the fewest studios first, then the cheapest; one without prices after those with.
    .sort((a, b) => a.ids.length - b.ids.length || (a.prices[0]?.priceCents ?? Infinity) - (b.prices[0]?.priceCents ?? Infinity));
  const between = catalog.settings.betweenLengthsMinutes;
  const longest = catalog.settings.longestBookingMinutes;

  return (
    <AdminFrame active="/admin/prices" title="Prices" query={await searchParams}>
      <div className="admin-card">
        <h3>How prices work</h3>
        <p style={{ fontSize: ".875rem", margin: 0 }}>
          Each studio has a price for every duration it offers, once for Monday to Friday and once for Saturday and
          Sunday. Studios booked together have a price list of their own, further down, the same on every day. Clear a
          price to take that duration off the list.
        </p>
        <form action={saveLengthsAction} className="admin-form-row" style={{ marginTop: "1rem", marginBottom: 0 }}>
          <div className="form-group">
            <label className="form-label" htmlFor="between-lengths">
              Lengths besides the listed ones
            </label>
            <select id="between-lengths" name="betweenLengthsMinutes" className="form-control" defaultValue={between}>
              <option value={30}>Can be booked, every half hour</option>
              <option value={60}>Can be booked, every whole hour</option>
              <option value={0}>Cannot be booked: only the durations listed</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="longest-booking">
              Every studio and bundle up to
            </label>
            <select id="longest-booking" name="longestBookingMinutes" className="form-control" defaultValue={longest}>
              {LONGEST_BOOKINGS.filter((minutes) => minutes > 0).map((minutes) => (
                <option key={minutes} value={minutes}>
                  {durationLabel(minutes)}
                </option>
              ))}
              <option value={0}>The longest duration each one lists</option>
            </select>
          </div>
          <button type="submit" className="btn btn-dark btn-small">
            Save
          </button>
        </form>
        <p style={{ fontSize: ".8rem", margin: ".75rem 0 0" }}>
          A length you did not list is priced from the ones you did, and rounded to a whole dollar. Between two durations,
          between their prices: with 2 hours at $230 and 3 hours at $320, 2.5 hours costs $275. Past the longest duration
          listed, the price goes on rising as it rose between the last two: with 4 hours at $400 and 5 hours at $490, 6
          hours costs $580. Nothing is shorter than the shortest duration listed. A duration you list always costs what you
          typed.
        </p>
      </div>

      {catalog.studios.map((studio) => (
        <div className="admin-card" key={studio.id}>
          <h3>{studio.name}</h3>
          <form action={savePricesAction}>
            <input type="hidden" name="studioId" value={studio.id} />
            <div className="data-table-wrap">
            <table className="data-table" style={{ maxWidth: 520 }}>
              <thead>
                <tr>
                  <th>Duration</th>
                  <th>Mon–Fri ($)</th>
                  <th>Sat–Sun ($)</th>
                </tr>
              </thead>
              <tbody>
                {priceTable(catalog, studio.id).map((row) => (
                  <tr key={row.durationMinutes}>
                    <td>{durationLabel(row.durationMinutes)}</td>
                    <td>
                      <input
                        name={`price:weekday:${row.durationMinutes}`}
                        className="price-input"
                        {...PRICE_FIELD}
                        aria-label={`${studio.name} ${durationLabel(row.durationMinutes)} weekday price`}
                        defaultValue={row.weekdayCents === null ? "" : centsToInput(row.weekdayCents)}
                      />
                    </td>
                    <td>
                      <input
                        name={`price:weekend:${row.durationMinutes}`}
                        className="price-input"
                        {...PRICE_FIELD}
                        aria-label={`${studio.name} ${durationLabel(row.durationMinutes)} weekend price`}
                        defaultValue={row.weekendCents === null ? "" : centsToInput(row.weekendCents)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <button type="submit" className="btn btn-dark btn-small" style={{ marginTop: "1rem" }}>
              Save {studio.name} prices
            </button>
          </form>

          <form action={addDurationAction} className="admin-form-row" style={{ marginTop: "1.5rem", marginBottom: 0 }}>
            <input type="hidden" name="studioId" value={studio.id} />
            <div className="form-group">
              <label className="form-label" htmlFor={`minutes-${studio.id}`}>
                Add a duration (minutes)
              </label>
              <input id={`minutes-${studio.id}`} name="minutes" className="form-control" type="number" min={15} max={1440} step={15} placeholder="360" required />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor={`weekday-${studio.id}`}>
                Mon–Fri ($)
              </label>
              <input id={`weekday-${studio.id}`} name="weekday" className="form-control" {...PRICE_FIELD} required />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor={`weekend-${studio.id}`}>
                Sat–Sun ($)
              </label>
              <input id={`weekend-${studio.id}`} name="weekend" className="form-control" {...PRICE_FIELD} placeholder="same" />
            </div>
            <button type="submit" className="btn btn-outline btn-small">
              Add
            </button>
          </form>
        </div>
      ))}

      {bundles.map((bundle) => (
        <div className="admin-card" key={bundle.ids.join("+")}>
          <h3>{bundle.name}</h3>
          <p style={{ fontSize: ".875rem" }}>
            {bundle.ids.map((id) => catalog.studios.find((studio) => studio.id === id)?.name).join(" + ")}, booked together.{" "}
            {bundle.prices.length > 0
              ? "One price for each duration, the same on every day of the week."
              : "No prices of their own yet: together they cost each studio's own price, less the discount below. Add a duration to give them a price list."}
          </p>
          {bundle.prices.length > 0 && (
            <form action={saveBundlePricesAction}>
              <input type="hidden" name="studioIds" value={bundle.ids.join(",")} />
              <div className="data-table-wrap">
                <table className="data-table" style={{ maxWidth: 360 }}>
                  <thead>
                    <tr>
                      <th>Duration</th>
                      <th>Price ($)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bundle.prices.map((row) => (
                      <tr key={row.durationMinutes}>
                        <td>{durationLabel(row.durationMinutes)}</td>
                        <td>
                          <input
                            name={`price:${row.durationMinutes}`}
                            className="price-input"
                            {...PRICE_FIELD}
                            aria-label={`${bundle.name} ${durationLabel(row.durationMinutes)} price`}
                            defaultValue={centsToInput(row.priceCents)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="submit" className="btn btn-dark btn-small" style={{ marginTop: "1rem" }}>
                Save {bundle.name} prices
              </button>
            </form>
          )}
          <form action={addBundleLengthAction} className="admin-form-row" style={{ marginTop: "1.5rem", marginBottom: 0 }}>
            <input type="hidden" name="studioIds" value={bundle.ids.join(",")} />
            <div className="form-group">
              <label className="form-label" htmlFor={`minutes-${bundle.ids.join("-")}`}>
                Add a duration (minutes)
              </label>
              <input id={`minutes-${bundle.ids.join("-")}`} name="minutes" className="form-control" type="number" min={15} max={1440} step={15} placeholder="360" required />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor={`price-${bundle.ids.join("-")}`}>
                Price ($)
              </label>
              <input id={`price-${bundle.ids.join("-")}`} name="price" className="form-control" {...PRICE_FIELD} required />
            </div>
            <button type="submit" className="btn btn-outline btn-small">
              Add
            </button>
          </form>
        </div>
      ))}

      <div className="admin-card">
        <h3>Studios together without prices of their own</h3>
        <p style={{ fontSize: ".875rem" }}>
          Taken off the studios&rsquo; own prices when studios are booked together that have no price list above.
          {bundles.length > 0 && bundles.every((bundle) => bundle.prices.length > 0) ? " Every bundle has one now, so this is not used." : ""}
        </p>
        <form action={saveDiscountAction} className="admin-form-row" style={{ marginBottom: 0 }}>
          <div className="form-group">
            <label className="form-label" htmlFor="discount-two">
              2 studios (% off)
            </label>
            <input
              id="discount-two"
              name="two"
              className="form-control"
              type="number"
              min={0}
              max={100}
              step={1}
              defaultValue={catalog.settings.multiStudioPercent[2] ?? 0}
              required
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="discount-three">
              3 or more (% off)
            </label>
            <input
              id="discount-three"
              name="three"
              className="form-control"
              type="number"
              min={0}
              max={100}
              step={1}
              defaultValue={catalog.settings.multiStudioPercent[3] ?? 0}
              required
            />
          </div>
          <button type="submit" className="btn btn-dark btn-small">
            Save discount
          </button>
        </form>
      </div>

      <div className="admin-card">
        <h3>Holidays and special dates</h3>
        <p style={{ fontSize: ".875rem" }}>Charge weekend prices on a weekday (a holiday), or weekday prices on a weekend day.</p>
        <form action={specialDateAction} className="admin-form-row">
          <div className="form-group">
            <label className="form-label" htmlFor="special-day">
              Date
            </label>
            <input id="special-day" name="day" type="date" className="form-control" min={today} required />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="special-type">
              Price as
            </label>
            <select id="special-type" name="dayType" className="form-control" defaultValue="weekend">
              <option value="weekend">Weekend</option>
              <option value="weekday">Weekday</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="special-note">
              Note
            </label>
            <input id="special-note" name="note" className="form-control" maxLength={200} />
          </div>
          <button type="submit" className="btn btn-dark btn-small">
            Save
          </button>
        </form>
        {special.map(([day, dayType]) => (
          <form action={specialDateAction} key={day} className="chip">
            <input type="hidden" name="day" value={day} />
            <input type="hidden" name="dayType" value="clear" />
            {longDateLabel(day)}: {dayType} prices
            <button type="submit" aria-label={`Clear ${longDateLabel(day)}`}>
              ×
            </button>
          </form>
        ))}
      </div>
    </AdminFrame>
  );
}
