import type { Metadata } from "next";
import Link from "next/link";
import { hasWeekendPricing, hourlyFromCents, priceTable } from "@/lib/catalog-view";
import { formatCents } from "@/lib/domain/pricing";
import { durationLabel } from "@/lib/domain/time";
import { getCatalog } from "@/server/cached";

export const metadata: Metadata = { title: "Rates" };

export default async function RatesPage() {
  const catalog = await getCatalog();
  const weekend = hasWeekendPricing(catalog);
  const discounts = Object.entries(catalog.settings.multiStudioPercent)
    .map(([count, percent]) => ({ count: Number(count), percent }))
    .filter((d) => d.percent > 0)
    .sort((a, b) => a.count - b.count);

  return (
    <>
      <div className="page-banner">
        <p className="section-eyebrow">Transparent Pricing</p>
        <h1>Studio Rates</h1>
        <p>Studio space rental only; a photographer is not included. Longer bookings cost less per hour.</p>
      </div>

      <section className="section section-cream">
        <div className="container">
          <div className="rates-grid">
            {catalog.studios.map((studio) => {
              const from = hourlyFromCents(catalog, studio.id);
              return (
                <div className="rate-card" key={studio.id}>
                  <h3>{studio.name}</h3>
                  {from !== null && (
                    <>
                      <div className="rate-price">{formatCents(from)}</div>
                      <div className="rate-unit">per hour</div>
                    </>
                  )}
                  <hr className="rate-divider" />
                  <table className="price-table">
                    {weekend && (
                      <thead>
                        <tr>
                          <td />
                          <td style={{ textAlign: "right" }}>Mon–Fri</td>
                          <td>Sat–Sun</td>
                        </tr>
                      </thead>
                    )}
                    <tbody>
                      {priceTable(catalog, studio.id).map((row) => (
                        <tr key={row.durationMinutes}>
                          <td style={{ textAlign: "left" }}>{durationLabel(row.durationMinutes)}</td>
                          {weekend && (
                            <td style={{ textAlign: "right" }}>
                              {row.weekdayCents === null ? "—" : formatCents(row.weekdayCents)}
                            </td>
                          )}
                          <td>
                            {(weekend ? row.weekendCents : row.weekdayCents) === null
                              ? "—"
                              : formatCents((weekend ? row.weekendCents : row.weekdayCents)!)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p style={{ fontSize: ".8rem", marginTop: "1rem" }}>Up to {studio.includedGuests} guests included.</p>
                  <Link href={`/book?studio=${studio.slug}`} className="btn btn-primary mt-2" style={{ width: "100%" }}>
                    Book Now
                  </Link>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {discounts.length > 0 && (
        <section className="section section-ivory">
          <div className="container-sm" style={{ textAlign: "center" }}>
            <p className="section-eyebrow">Several Studios</p>
            <h2>Book Any Studios Together</h2>
            <div className="divider" />
            <p>
              Select any combination of studios in one booking. Each is reserved for you for the whole session.{" "}
              {discounts
                .map((d) => `${d.percent}% off when you book ${d.count}${d === discounts.at(-1) ? " or more" : ""}`)
                .join(", ")}
              .
            </p>
            <Link href="/book" className="btn btn-dark mt-3">
              Choose Studios →
            </Link>
          </div>
        </section>
      )}

      {catalog.addons.length > 0 && (
        <section className="section section-cream">
          <div className="container-sm">
            <div className="section-header">
              <p className="section-eyebrow">Extras</p>
              <h2>Add-ons</h2>
              <div className="divider" />
            </div>
            <table className="price-table">
              <tbody>
                {catalog.addons.map((addon) => (
                  <tr key={addon.id}>
                    <td>
                      <strong style={{ color: "var(--color-dark)" }}>{addon.name}</strong>
                      <br />
                      {addon.description}
                    </td>
                    <td>{formatCents(addon.priceCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
