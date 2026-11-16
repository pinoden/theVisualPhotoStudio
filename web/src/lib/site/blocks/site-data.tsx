import Image from "next/image";
import { ContactForm as ContactFormView } from "@/components/ContactForm";
import { hasWeekendPricing, hourlyFromCents, hoursLines, openingHours, priceTable } from "@/lib/catalog-view";
import { formatCents } from "@/lib/domain/pricing";
import { durationLabel } from "@/lib/domain/time";
import { telHref } from "../frame";
import { defineBlock } from "./block";
import { EditorNote, SiteAnchor } from "./shared";

/**
 * The blocks that show the studio's own data: the studios, their prices, the
 * add-ons, the contact details and opening hours, and the contact form. What
 * they show comes from the admin's other pages (Studios & add-ons, Prices,
 * Hours, Settings, the header and footer's contact details), so a page made
 * of them cannot disagree with what can be booked. Only their words are set
 * here.
 */

const MISSING = "The studio's data is not loaded here.";

export const StudioCards = defineBlock({
  label: "Studio cards",
  group: "site",
  fields: {
    prices: { kind: "toggle", label: "Show the price per hour", start: true },
    viewLabel: { kind: "text", label: "Words on the button that shows a studio", max: 30, start: "View Studio" },
    bookLabel: { kind: "text", label: "Words on the button that books it", max: 30, start: "Book Now" },
  },
  render: ({ prices, viewLabel, bookLabel, site, editing }) => {
    const catalog = site.catalog;
    if (!catalog) return <EditorNote editing={editing}>{MISSING}</EditorNote>;
    return (
      <div className="blk studios-grid">
        {catalog.studios.map((studio) => {
          const from = hourlyFromCents(catalog, studio.id);
          const photo = studio.photos[0];
          return (
            <div className="studio-card" key={studio.id}>
              <div className={`studio-card-img ${studio.slug}-bg`}>
                {photo ? (
                  <Image className="studio-photo" src={photo.url} width={photo.width} height={photo.height} alt={photo.alt} sizes="(max-width: 700px) 100vw, (max-width: 1100px) 50vw, 400px" quality={85} />
                ) : (
                  <span className="studio-placeholder-text">{studio.name}</span>
                )}
              </div>
              <div className="studio-card-body">
                <h3>{studio.name}</h3>
                <p>{studio.tagline}</p>
                {prices && from !== null && <p className="studio-price">From {formatCents(from)}/hour</p>}
                {(viewLabel || bookLabel) && (
                  <div className="studio-card-buttons">
                    {viewLabel && (
                      <SiteAnchor href={`/studios#${studio.slug}`} className="btn btn-outline" editing={editing}>
                        {viewLabel}
                      </SiteAnchor>
                    )}
                    {bookLabel && (
                      <SiteAnchor href={`/book?studio=${studio.slug}`} className="btn btn-primary" editing={editing}>
                        {bookLabel}
                      </SiteAnchor>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  },
});

export const StudioDetails = defineBlock({
  label: "Each studio in full",
  group: "site",
  fields: {
    bookLabel: { kind: "text", label: "Words on the booking button, before the studio's name", max: 30, start: "Book" },
  },
  render: ({ bookLabel, site, editing }) => {
    const catalog = site.catalog;
    if (!catalog) return <EditorNote editing={editing}>{MISSING}</EditorNote>;
    return (
      <div className="blk blk-studio-details">
        {catalog.studios.map((studio, index) => {
          const from = hourlyFromCents(catalog, studio.id);
          const [photo, ...more] = studio.photos;
          return (
            <section id={studio.slug} key={studio.id} className={`section ${index % 2 === 0 ? "section-cream" : "section-ivory"}`} style={{ scrollMarginTop: 72 }}>
              <div className="container">
                <div className="two-col">
                  <div>
                    <div className={`studio-card-img ${studio.slug}-bg`} style={{ height: 340 }}>
                      {photo ? (
                        <Image className="studio-photo" src={photo.url} width={photo.width} height={photo.height} alt={photo.alt} sizes="(max-width: 768px) 100vw, 560px" quality={85} loading={index === 0 ? "eager" : "lazy"} />
                      ) : (
                        <span className="studio-placeholder-text">{studio.name}</span>
                      )}
                    </div>
                    {more.length > 0 && (
                      <ul className="studio-photo-strip" aria-label={`More photos of ${studio.name}`}>
                        {more.map((picture) => (
                          <li key={picture.id}>
                            <SiteAnchor href={picture.url} editing={editing}>
                              <Image src={picture.url} width={picture.width} height={picture.height} alt={picture.alt} sizes="120px" />
                            </SiteAnchor>
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
                    {bookLabel && (
                      <SiteAnchor href={`/book?studio=${studio.slug}`} className="btn btn-dark" editing={editing}>
                        {bookLabel} {studio.name.replace(/^Studio /, "")}
                      </SiteAnchor>
                    )}
                  </div>
                </div>
              </div>
            </section>
          );
        })}
      </div>
    );
  },
});

export const RateCards = defineBlock({
  label: "Prices of the studios",
  group: "site",
  fields: {
    bookLabel: { kind: "text", label: "Words on the booking button", max: 30, start: "Book Now" },
  },
  render: ({ bookLabel, site, editing }) => {
    const catalog = site.catalog;
    if (!catalog) return <EditorNote editing={editing}>{MISSING}</EditorNote>;
    const weekend = hasWeekendPricing(catalog);
    return (
      <div className="blk rates-grid">
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
                      {weekend && <td style={{ textAlign: "right" }}>{row.weekdayCents === null ? "—" : formatCents(row.weekdayCents)}</td>}
                      <td>{(weekend ? row.weekendCents : row.weekdayCents) === null ? "—" : formatCents((weekend ? row.weekendCents : row.weekdayCents)!)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ fontSize: ".8rem", marginTop: "1rem" }}>Up to {studio.includedGuests} guests included.</p>
              {bookLabel && (
                <SiteAnchor href={`/book?studio=${studio.slug}`} className="btn btn-primary mt-2 rate-book" editing={editing}>
                  {bookLabel}
                </SiteAnchor>
              )}
            </div>
          );
        })}
      </div>
    );
  },
});

export const AddonPrices = defineBlock({
  label: "Prices of the add-ons",
  group: "site",
  fields: {},
  render: ({ site, editing }) => {
    const catalog = site.catalog;
    if (!catalog) return <EditorNote editing={editing}>{MISSING}</EditorNote>;
    if (catalog.addons.length === 0) return <EditorNote editing={editing}>No add-on is offered at the moment, so visitors see nothing here.</EditorNote>;
    return (
      <table className="blk price-table blk-addons">
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
    );
  },
});

export const ContactDetails = defineBlock({
  label: "Address, phone and hours",
  group: "site",
  fields: {
    addressLabel: { kind: "text", label: "Heading above the address", max: 40, start: "Address" },
    phoneLabel: { kind: "text", label: "Heading above the phone number", max: 40, start: "Phone" },
    hoursLabel: { kind: "text", label: "Heading above the opening hours (empty: no hours)", max: 40, start: "Studio Hours" },
    mapLabel: { kind: "text", label: "Words of the link to the map (empty: no link)", max: 40, start: "Open in Maps" },
    signs: { kind: "toggle", label: "A small sign beside each", start: false },
  },
  render: ({ addressLabel, phoneLabel, hoursLabel, mapLabel, signs, site, editing }) => {
    const { business, catalog } = site;
    if (!business || !catalog) return <EditorNote editing={editing}>{MISSING}</EditorNote>;
    const hours = openingHours(catalog);
    return (
      <div className="blk blk-contact">
        <div className="contact-detail">
          {signs && (
            <div className="contact-icon" aria-hidden="true">
              📍
            </div>
          )}
          <div>
            {addressLabel && (
              <>
                <strong>{addressLabel}</strong>
                <br />
              </>
            )}
            {business.addressLine1}
            <br />
            {business.addressLine2}
            {mapLabel && (
              <>
                <br />
                <SiteAnchor href={business.mapsUrl} editing={editing}>
                  {mapLabel}
                </SiteAnchor>
              </>
            )}
          </div>
        </div>
        <div className="contact-detail">
          {signs && (
            <div className="contact-icon" aria-hidden="true">
              📞
            </div>
          )}
          <div>
            {phoneLabel && (
              <>
                <strong>{phoneLabel}</strong>
                <br />
              </>
            )}
            {editing ? business.phone : <a href={telHref(business.phone)}>{business.phone}</a>}
          </div>
        </div>
        {hoursLabel && (
          <div className="contact-detail">
            {signs && (
              <div className="contact-icon" aria-hidden="true">
                🕐
              </div>
            )}
            <div>
              <strong>{hoursLabel}</strong>
              {hours.map((group) => (
                <div key={group.studios || "all"} style={group.studios ? { marginTop: ".5rem" } : undefined}>
                  {group.studios && <em>{group.studios}</em>}
                  {group.lines.map((line) => (
                    <div key={line}>{line}</div>
                  ))}
                </div>
              ))}
              {business.note && <em style={{ fontSize: ".85rem", color: "var(--color-muted)" }}>{business.note}</em>}
            </div>
          </div>
        )}
      </div>
    );
  },
});

export const ContactForm = defineBlock({
  label: "Contact form",
  group: "site",
  fields: {},
  // In the editor it is a picture of the form, so that pressing it does not send a message.
  render: ({ editing }) =>
    editing ? (
      <div className="blk blk-note">The contact form. Visitors write to you here, and each message is emailed to you.</div>
    ) : (
      <div className="blk">
        <ContactFormView />
      </div>
    ),
});
