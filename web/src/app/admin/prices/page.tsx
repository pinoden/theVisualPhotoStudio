import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { priceTable } from "@/lib/catalog-view";
import { durationLabel, longDateLabel } from "@/lib/domain/time";
import { centsToInput, PRICE_FIELD } from "@/lib/parse";
import { loadCatalog } from "@/server/catalog";
import { requireOwner } from "@/server/session";
import { localDateOf } from "@/server/tz";
import { addDurationAction, saveDiscountAction, savePricesAction, specialDateAction } from "../actions";
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

  return (
    <AdminFrame active="/admin/prices" title="Prices" query={await searchParams}>
      <div className="admin-card">
        <h3>How prices work</h3>
        <p style={{ fontSize: ".875rem", margin: 0 }}>
          Each studio has a price for every duration it offers, once for Monday to Friday and once for Saturday and
          Sunday. A customer can only book the durations listed. Clear a price to stop offering that duration on that
          kind of day.
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

      <div className="admin-card">
        <h3>Booking several studios together</h3>
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
