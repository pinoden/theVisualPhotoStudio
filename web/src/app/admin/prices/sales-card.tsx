import Link from "next/link";
import { formatCents } from "@/lib/domain/pricing";
import { bookableOn, saleCodesWords, salePriceCents, saleWords, SALE_PERCENT_MAX, type Sale } from "@/lib/domain/sale";
import { longDateLabel, type IsoDate } from "@/lib/domain/time";
import type { Catalog } from "@/server/catalog";
import { saleAction, saveSaleAction } from "../actions";

/** "On now", "Starts Friday, November 27, 2026", "Ended Saturday, November 28, 2026". */
function saleStatus(sale: Sale, today: IsoDate): string {
  if (bookableOn(sale, today)) return "On now";
  return sale.bookFrom > today ? `Starts ${longDateLabel(sale.bookFrom)}` : `Ended ${longDateLabel(sale.bookUntil)}`;
}

/**
 * Sales (the owner, 2026-11-27; question 87 in ProjectLibrary.md): the studios' prices lowered for some days, by the
 * owners, with no deployment. On the Rates page, the studios' pages and the booking screen the usual price is crossed
 * out beside the sale's. The card lists the sales, newest first, and adds or changes one.
 */
export function SalesCard({ sales, catalog, today, editing }: { sales: Sale[]; catalog: Pick<Catalog, "studios" | "rules">; today: IsoDate; editing: Sale | null }) {
  // What an hour costs today, for the example under the form: the first studio's weekday hour.
  const example = catalog.rules.find((rule) => rule.studioId === catalog.studios[0]?.id && rule.dayType === "weekday" && rule.durationMinutes === 60 && !rule.between);
  const shown = sales.filter((sale) => sale.bookUntil >= today || sale.id === editing?.id).concat(sales.filter((sale) => sale.bookUntil < today && sale.id !== editing?.id).slice(0, 5));
  return (
    <>
      <div className="admin-card" id="sales">
        <h3>Sales</h3>
        <p style={{ fontSize: ".875rem" }}>
          Lower the studios&rsquo; prices for some days: a Black Friday weekend, a quiet week. While a sale is on, the Rates page, the studios&rsquo; pages and the booking
          screen show the usual price crossed out beside the sale&rsquo;s, and a booking made on those days is charged the lower price. It begins and ends by itself, at midnight.
          Sessions with the studio&rsquo;s photographer or content creator, add-ons and memberships are not part of a sale.
        </p>
        {shown.length === 0 ? (
          <p>No sale yet.</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Sale</th>
                  <th>What clients read</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((sale) => (
                  <tr key={sale.id}>
                    <td>{sale.name}</td>
                    <td>
                      {saleWords(sale, catalog.studios)}.{saleCodesWords(sale)} Booked from {longDateLabel(sale.bookFrom)}.
                    </td>
                    <td>{saleStatus(sale, today)}</td>
                    <td>
                      <form action={saleAction} className="forms-row-actions">
                        <input type="hidden" name="id" value={sale.id} />
                        <Link href={`/admin/prices?sale=${sale.id}#sale-form`} className="btn btn-outline btn-small">
                          Edit
                        </Link>
                        {bookableOn(sale, today) && (
                          <button type="submit" name="intent" value="end" className="btn btn-outline btn-small" aria-label={`End now: ${sale.name}`}>
                            End now
                          </button>
                        )}
                        <button type="submit" name="intent" value="delete" className="btn btn-outline btn-small" aria-label={`Delete: ${sale.name}`}>
                          Delete
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="avail-hint">A booking keeps the price it was made at when its sale ends, is changed or is deleted.</p>
      </div>

      {/* A form of its own for each sale changed: one already on screen keeps what its fields held, not their new defaults. */}
      <form action={saveSaleAction} className="admin-card" id="sale-form" key={`sale-${editing?.id ?? "new"}`}>
        <h3>{editing ? `Change ${editing.name}` : "Add a sale"}</h3>
        {editing && <input type="hidden" name="id" value={editing.id} />}
        <div className="admin-form-row">
          <div className="form-group" style={{ flex: "2 1 14rem" }}>
            <label className="form-label" htmlFor="sale-name">
              Name, as clients read it
            </label>
            <input id="sale-name" name="name" className="form-control" maxLength={60} defaultValue={editing?.name ?? ""} placeholder="Black Friday" required />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="sale-percent">
              Percent off
            </label>
            <input id="sale-percent" name="percent" className="form-control" inputMode="numeric" pattern="[0-9]{1,2}" maxLength={2} defaultValue={editing?.percent ?? ""} required />
          </div>
        </div>
        {example && (
          <p className="avail-hint">
            Prices on sale are whole dollars. {catalog.studios[0].name}&rsquo;s weekday hour, {formatCents(example.priceCents)} today: {[10, 15, 17, 20, 25].map((percent) => `${percent}% off is ${formatCents(salePriceCents(example.priceCents, percent))}`).join(", ")}. At most {SALE_PERCENT_MAX}%.
          </p>
        )}
        <fieldset className="admin-fieldset">
          <legend className="form-label">Studios on sale</legend>
          {catalog.studios.map((studio) => (
            <label key={studio.id} className="avail-check">
              <input type="checkbox" name="studio" value={studio.id} defaultChecked={editing?.studioIds.includes(studio.id) ?? false} /> {studio.name}
            </label>
          ))}
          <p className="avail-hint">None ticked: every studio. Studios booked together at a price of their own are on sale when each of them is.</p>
        </fieldset>
        <div className="admin-form-row">
          <div className="form-group">
            <label className="form-label" htmlFor="sale-book-from">
              Booked from
            </label>
            <input id="sale-book-from" name="bookFrom" type="date" className="form-control" defaultValue={editing?.bookFrom ?? today} required />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="sale-book-until">
              Booked until (the last day)
            </label>
            <input id="sale-book-until" name="bookUntil" type="date" className="form-control" defaultValue={editing?.bookUntil ?? today} required />
          </div>
        </div>
        <p className="avail-hint">The days on which a client can book at the sale&rsquo;s prices, whatever day their studio time is.</p>
        <div className="admin-form-row">
          <div className="form-group">
            <label className="form-label" htmlFor="sale-visit-from">
              For studio time from (optional)
            </label>
            <input id="sale-visit-from" name="visitFrom" type="date" className="form-control" defaultValue={editing?.visitFrom ?? ""} />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="sale-visit-until">
              For studio time until (optional)
            </label>
            <input id="sale-visit-until" name="visitUntil" type="date" className="form-control" defaultValue={editing?.visitUntil ?? ""} />
          </div>
        </div>
        <p className="avail-hint">Fill these in to lower the prices only of studio time on some days: this weekend, or until Christmas. Left empty, the sale is for any day.</p>
        <label className="avail-check">
          <input type="checkbox" name="withCodes" defaultChecked={editing?.withCodes ?? false} /> A discount code can be used on top of this sale
        </label>
        <p className="avail-hint">
          Not ticked: a client gets the sale&rsquo;s price or their code&rsquo;s discount, whichever leaves them less to pay, and never both. A code that is not used
          stays theirs. A discount code is a percentage off or a free hour; studio credit, a reschedule code and membership hours are payment, and pay a sale&rsquo;s
          price like any other.
        </p>
        <div className="avail-actions">
          <button type="submit" className="btn btn-dark btn-small">
            {editing ? "Save the sale" : "Add the sale"}
          </button>
          {editing && (
            <Link href="/admin/prices#sales" className="btn btn-outline btn-small">
              Cancel
            </Link>
          )}
        </div>
      </form>
    </>
  );
}
