import type { Metadata } from "next";
import Link from "next/link";
import { ContactForm } from "@/components/ContactForm";
import { hoursLines } from "@/lib/catalog-view";
import { SITE } from "@/lib/site";
import type { Catalog } from "@/server/catalog";
import { getCatalog } from "@/server/cached";

export const metadata: Metadata = { title: "Contact" };

/** Opening hours as lines of text, once when every studio keeps the same hours, else per studio. */
function openingHours(catalog: Catalog): { studios: string; lines: string[] }[] {
  const groups = new Map<string, { names: string[]; lines: string[] }>();
  for (const studio of catalog.studios) {
    const lines = hoursLines(studio);
    const group = groups.get(lines.join("|")) ?? { names: [], lines };
    group.names.push(studio.name);
    groups.set(lines.join("|"), group);
  }
  return [...groups.values()].map((group) => ({
    studios: groups.size === 1 ? "" : group.names.join(", "),
    lines: group.lines,
  }));
}

export default async function ContactPage() {
  const hours = openingHours(await getCatalog());

  return (
    <>
      <div className="page-banner">
        <p className="section-eyebrow">Get in Touch</p>
        <h1>Contact Us</h1>
        <p>Have a question, or want to talk through a booking? Send us a message and we will get back to you.</p>
      </div>

      <section className="section section-cream">
        <div className="container">
          <div className="contact-grid">
            <div>
              <h2 style={{ marginTop: 0, marginBottom: "2rem" }}>Visit Us</h2>

              <div className="contact-detail">
                <div>
                  <strong>Address</strong>
                  <br />
                  {SITE.addressLine1}
                  <br />
                  {SITE.addressLine2}
                  <br />
                  <a href={SITE.mapsUrl} target="_blank" rel="noreferrer">
                    Open in Maps
                  </a>
                </div>
              </div>

              <div className="contact-detail">
                <div>
                  <strong>Phone</strong>
                  <br />
                  <a href={SITE.phoneHref}>{SITE.phoneDisplay}</a>
                </div>
              </div>

              <div className="contact-detail">
                <div>
                  <strong>Studio Hours</strong>
                  {hours.map((group) => (
                    <div key={group.studios || "all"} style={group.studios ? { marginTop: ".5rem" } : undefined}>
                      {group.studios && <em>{group.studios}</em>}
                      {group.lines.map((line) => (
                        <div key={line}>{line}</div>
                      ))}
                    </div>
                  ))}
                  <em style={{ fontSize: ".85rem", color: "var(--color-muted)" }}>By appointment only</em>
                </div>
              </div>

              <div className="mt-4" style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
                <Link href="/book" className="btn btn-dark">
                  Book a Studio
                </Link>
                <Link href="/faq" className="btn btn-outline">
                  Guest Information
                </Link>
              </div>
            </div>

            <ContactForm />
          </div>
        </div>
      </section>
    </>
  );
}
