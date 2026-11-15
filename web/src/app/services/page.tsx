import type { Metadata } from "next";
import Link from "next/link";
import { noticeHours } from "@/lib/domain/availability";
import { formatCents } from "@/lib/domain/pricing";
import { hoursInWords } from "@/lib/words";
import { getCatalog } from "@/server/cached";

export const metadata: Metadata = { title: "Professional Photography" };

/** What each package includes, as on the studio's current site. */
const PACKAGES = [
  { duration: "1 hour", outfits: "1–2", pictures: 20 },
  { duration: "2 hours", outfits: "2–3", pictures: 30 },
  { duration: "3 hours", outfits: "3–4", pictures: 40 },
  { duration: "4 hours", outfits: "4–5", pictures: 50 },
];

/**
 * The studio's photography sessions. They are booked online in the
 * photography flow (`/book/photography`), which has the price of every
 * session. This page says what a session is and where the prices start; when
 * no session is on sale it asks for a message instead.
 */
export default async function ServicesPage() {
  const catalog = await getCatalog();
  const from = catalog.photoPackages.length > 0 ? Math.min(...catalog.photoPackages.map((p) => p.priceCents)) : null;
  /** How far ahead a session has to be booked: the owner's setting, so this page follows the admin. */
  const notice = noticeHours(catalog.settings, true);
  return (
    <>
      <div className="page-banner">
        <p className="section-eyebrow">Services</p>
        <h1>Professional Photography</h1>
        <p>
          Want professional pictures taken at our studio, but don&rsquo;t have a photographer? Book a session with
          our own photographer.
        </p>
      </div>

      <section className="section section-cream">
        <div className="container-sm">
          <div className="section-header">
            <p className="section-eyebrow">Every Package</p>
            <h2>What&rsquo;s Included</h2>
            <div className="divider" />
            <p>
              Every package comes with the rental of the studio space, and each session is shot with a professional
              camera. The packages suit any type of photography: portraits, maternity, family sessions and more.
            </p>
          </div>

          <table className="price-table">
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Outfits</th>
                <th scope="col">Edited pictures</th>
              </tr>
            </thead>
            <tbody>
              {PACKAGES.map((row) => (
                <tr key={row.duration}>
                  <td>
                    <strong style={{ color: "var(--color-dark)" }}>{row.duration}</strong>
                  </td>
                  <td>{row.outfits}</td>
                  <td>{row.pictures}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontSize: ".875rem", marginTop: "1rem" }}>Final images are delivered within 7 to 14 days.</p>
        </div>
      </section>

      <section className="section section-ivory">
        <div className="container-sm" style={{ textAlign: "center" }}>
          <p className="section-eyebrow">How to Book</p>
          {from !== null ? (
            <>
              <h2>Choose a Studio, a Session and a Time</h2>
              <div className="divider" />
              <p>
                Pick the studio you would like to be photographed in; its rental is included in the price. Then choose
                the session length and one of the times our photographer is free, and pay online. Sessions start at{" "}
                {formatCents(from)}.{notice > 0 && ` Please book at least ${hoursInWords(notice)} ahead.`}
              </p>
              <div className="mt-3" style={{ display: "flex", gap: "1rem", justifyContent: "center", flexWrap: "wrap" }}>
                <Link href="/studios" className="btn btn-outline">
                  See the Studios
                </Link>
                <Link href="/book/photography" className="btn btn-dark">
                  Book a Photographer
                </Link>
              </div>
            </>
          ) : (
            <>
              <h2>Choose a Studio, Then Tell Us When</h2>
              <div className="divider" />
              <p>
                Pick the studio you would like to be photographed in; its rental is included in the price. Then send
                us a message with the session length and the dates that suit you, and we will reply with the price and
                the times our photographer is free.
              </p>
              <div className="mt-3" style={{ display: "flex", gap: "1rem", justifyContent: "center", flexWrap: "wrap" }}>
                <Link href="/studios" className="btn btn-outline">
                  See the Studios
                </Link>
                <Link href="/contact" className="btn btn-dark">
                  Ask About a Session
                </Link>
              </div>
            </>
          )}
          <p style={{ fontSize: ".875rem", marginTop: "1.5rem" }}>
            Bringing your own photographer? <Link href="/book">Book a studio</Link> by the hour.
          </p>
        </div>
      </section>
    </>
  );
}
