import Link from "next/link";
import { hourlyFromCents, hoursLines } from "@/lib/catalog-view";
import { formatCents } from "@/lib/domain/pricing";
import { telHref } from "@/lib/site/frame";
import { getCatalog } from "@/server/cached";
import { siteFrame } from "@/server/site";
import type { CSSProperties } from "react";

/** The size a heading has in its place, which the design's scale then multiplies (see ".site-page" in globals.css). */
const headingBase = (level: 2 | 4, size: string) => ({ [`--h${level}-base`]: size }) as CSSProperties;

export default async function HomePage() {
  const [catalog, { frame }] = await Promise.all([getCatalog(), siteFrame()]);
  const { business } = frame;
  const first = catalog.studios[0];

  return (
    <div className="site-page">
      <section className="hero">
        <div className="hero-content">
          <p className="hero-eyebrow">Winter Park, Florida</p>
          <h1>
            Where Every Frame
            <br />
            <em>Tells a Story</em>
          </h1>
          <p>
            Three unique natural-light studios available by the hour. For photographers, brands, content creators
            and families.
          </p>
          <div style={{ display: "flex", gap: "1rem", justifyContent: "center", flexWrap: "wrap" }}>
            <Link href="/book" className="btn btn-dark">
              Book a Studio
            </Link>
            <Link href="/studios" className="btn btn-ghost">
              Explore Studios
            </Link>
          </div>
        </div>
      </section>

      <section className="section section-cream">
        <div className="container">
          <div className="section-header">
            <p className="section-eyebrow">Our Spaces</p>
            <h2>Three Studios, One Vision</h2>
            <div className="divider" />
            <p>Each studio has its own look. Book one, or any combination of them for the same time.</p>
          </div>
          <div className="studios-grid">
            {catalog.studios.map((studio) => {
              const from = hourlyFromCents(catalog, studio.id);
              return (
                <div className="studio-card" key={studio.id}>
                  <div className={`studio-card-img ${studio.slug}-bg`}>
                    <span className="studio-placeholder-text">{studio.name}</span>
                  </div>
                  <div className="studio-card-body">
                    <h3>{studio.name}</h3>
                    <p>{studio.tagline}</p>
                    {from !== null && <p className="studio-price">From {formatCents(from)}/hour</p>}
                    <div style={{ marginTop: "1.25rem", display: "flex", gap: ".75rem", flexWrap: "wrap" }}>
                      <Link
                        href={`/studios#${studio.slug}`}
                        className="btn btn-outline"
                        style={{ padding: ".5rem 1.25rem", fontSize: ".78rem" }}
                      >
                        View Studio
                      </Link>
                      <Link
                        href={`/book?studio=${studio.slug}`}
                        className="btn btn-primary"
                        style={{ padding: ".5rem 1.25rem", fontSize: ".78rem" }}
                      >
                        Book Now
                      </Link>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="section section-ivory">
        <div className="container">
          <div className="section-header">
            <p className="section-eyebrow">How Booking Works</p>
            <h2>Two Ways to Book</h2>
            <div className="divider" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: "2rem" }}>
            <div style={{ textAlign: "center", padding: "1.5rem" }}>
              <div style={{ fontSize: "2rem", marginBottom: "1rem" }}>✦</div>
              <h4 style={{ ...headingBase(4, "1.2rem"), marginBottom: ".5rem" }}>Know the studio?</h4>
              <p style={{ fontSize: ".875rem" }}>Pick one or more studios and see every time they are free together.</p>
            </div>
            <div style={{ textAlign: "center", padding: "1.5rem" }}>
              <div style={{ fontSize: "2rem", marginBottom: "1rem" }}>✦</div>
              <h4 style={{ ...headingBase(4, "1.2rem"), marginBottom: ".5rem" }}>Know the time?</h4>
              <p style={{ fontSize: ".875rem" }}>Pick a date and time and see which studios are free then.</p>
            </div>
            <div style={{ textAlign: "center", padding: "1.5rem" }}>
              <div style={{ fontSize: "2rem", marginBottom: "1rem" }}>✦</div>
              <h4 style={{ ...headingBase(4, "1.2rem"), marginBottom: ".5rem" }}>Need more space?</h4>
              <p style={{ fontSize: ".875rem" }}>
                Add any other studio to the same booking. The multi-studio discount applies automatically.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="section section-cream">
        <div className="container">
          <div className="two-col">
            <div>
              <p className="section-eyebrow">Find Us</p>
              <h2>Located in Winter Park</h2>
              <div className="divider" style={{ margin: "1rem 0" }} />
              <div className="contact-detail">
                <div className="contact-icon">📍</div>
                <div>
                  <strong style={{ color: "var(--color-dark)" }}>Address</strong>
                  <br />
                  {business.addressLine1}
                  <br />
                  {business.addressLine2}
                </div>
              </div>
              <div className="contact-detail">
                <div className="contact-icon">📞</div>
                <div>
                  <strong style={{ color: "var(--color-dark)" }}>Phone</strong>
                  <br />
                  <a href={telHref(business.phone)}>{business.phone}</a>
                </div>
              </div>
              {first && (
                <div className="contact-detail">
                  <div className="contact-icon">🕐</div>
                  <div>
                    <strong style={{ color: "var(--color-dark)" }}>Hours</strong>
                    <br />
                    {hoursLines(first).map((line) => (
                      <span key={line}>
                        {line}
                        <br />
                      </span>
                    ))}
                    {business.note && <em style={{ fontSize: ".8rem" }}>{business.note}</em>}
                  </div>
                </div>
              )}
            </div>
            <div
              style={{
                background: "var(--color-ivory)",
                border: "1px solid var(--color-border)",
                height: 320,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: "2.5rem", marginBottom: ".75rem" }}>📍</div>
                <p style={{ fontSize: ".9rem" }}>
                  {business.addressLine1}
                  <br />
                  {business.addressLine2}
                </p>
                <a
                  href={business.mapsUrl}
                  target="_blank"
                  rel="noopener"
                  className="btn btn-primary mt-2"
                  style={{ fontSize: ".78rem", padding: ".5rem 1.25rem" }}
                >
                  Open in Maps
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section section-ivory" style={{ textAlign: "center" }}>
        <div className="container-sm">
          <p className="section-eyebrow">Ready to Create?</p>
          <h2 style={headingBase(2, "clamp(2rem,4vw,3.5rem)")}>Book Your Session Today</h2>
          <div className="divider" />
          <p style={{ maxWidth: 480, margin: "0 auto 2rem" }}>
            Choose your space, pick a time and get instant confirmation.
          </p>
          <Link href="/book" className="btn btn-dark" style={{ fontSize: ".95rem", padding: ".9rem 2.5rem" }}>
            Book a Studio →
          </Link>
        </div>
      </section>
    </div>
  );
}
