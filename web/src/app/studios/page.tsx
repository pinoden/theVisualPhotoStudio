import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { hourlyFromCents, hoursLines } from "@/lib/catalog-view";
import { formatCents } from "@/lib/domain/pricing";
import { getCatalog } from "@/server/cached";

export const metadata: Metadata = { title: "Our Studios" };

export default async function StudiosPage() {
  const catalog = await getCatalog();
  return (
    <div className="site-page">
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
                <div>
                  <div className={`studio-card-img ${studio.slug}-bg`} style={{ height: 340 }}>
                    {studio.photos[0] ? (
                      <Image
                        className="studio-photo"
                        src={studio.photos[0].url}
                        width={studio.photos[0].width}
                        height={studio.photos[0].height}
                        alt={studio.photos[0].alt}
                        sizes="(max-width: 768px) 100vw, 560px"
                        quality={85}
                        // The first studio's photo is on screen when the page opens.
                        loading={index === 0 ? "eager" : "lazy"}
                      />
                    ) : (
                      <span className="studio-placeholder-text">{studio.name}</span>
                    )}
                  </div>
                  {studio.photos.length > 1 && (
                    <ul className="studio-photo-strip" aria-label={`More photos of ${studio.name}`}>
                      {studio.photos.slice(1).map((photo) => (
                        <li key={photo.id}>
                          <a href={photo.url} target="_blank" rel="noopener">
                            <Image src={photo.url} width={photo.width} height={photo.height} alt={photo.alt} sizes="120px" />
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <p className="section-eyebrow">{studio.tagline}</p>
                  <h2>{studio.name}</h2>
                  <div className="divider" style={{ margin: "1rem 0" }} />
                  {/* pre-line: the owner's line breaks and paragraphs are kept. */}
                  <p style={{ whiteSpace: "pre-line" }}>{studio.description}</p>
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
    </div>
  );
}
