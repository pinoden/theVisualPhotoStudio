import type { Metadata } from "next";
import Link from "next/link";
import { hourlyFromCents, hoursLines } from "@/lib/catalog-view";
import { formatCents } from "@/lib/domain/pricing";
import { getCatalog } from "@/server/cached";

export const metadata: Metadata = { title: "Our Studios" };

export default async function StudiosPage() {
  const catalog = await getCatalog();
  return (
    <>
      <div className="page-banner">
        <p className="section-eyebrow">Our Spaces</p>
        <h1>The Studios</h1>
        <p>Three natural-light studios on the third floor at 7457 Aloma Ave. Book one, or several together.</p>
      </div>

      {catalog.studios.map((studio, index) => {
        const from = hourlyFromCents(catalog, studio.id);
        return (
          <section
            id={studio.slug}
            key={studio.id}
            className={`section ${index % 2 === 0 ? "section-cream" : "section-ivory"}`}
            style={{ scrollMarginTop: 72 }}
          >
            <div className="container">
              <div className="two-col">
                <div className={`studio-card-img ${studio.slug}-bg`} style={{ height: 340 }}>
                  <span className="studio-placeholder-text">{studio.name}</span>
                </div>
                <div>
                  <p className="section-eyebrow">{studio.tagline}</p>
                  <h2>{studio.name}</h2>
                  <div className="divider" style={{ margin: "1rem 0" }} />
                  <p>{studio.description}</p>
                  <ul className="rate-details" style={{ listStyle: "none", padding: 0, margin: "1rem 0" }}>
                    <li>Up to {studio.includedGuests} guests included</li>
                    {hoursLines(studio).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                    {from !== null && <li>From {formatCents(from)} per hour</li>}
                  </ul>
                  <Link href={`/book?studio=${studio.slug}`} className="btn btn-dark">
                    Book {studio.name.replace(/^Studio /, "")}
                  </Link>
                </div>
              </div>
            </div>
          </section>
        );
      })}
    </>
  );
}
