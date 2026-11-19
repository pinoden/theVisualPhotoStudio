import Image from "next/image";
import { ContactForm as ContactFormView } from "@/components/ContactForm";
import { PictureRow } from "@/components/site/PictureRow";
import { hasWeekendPricing, hourlyFromCents, hoursLines, openingHours, priceTable } from "@/lib/catalog-view";
import { formatCents } from "@/lib/domain/pricing";
import { durationLabel } from "@/lib/domain/time";
import { FACT_LABELS } from "@/lib/studio-facts";
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
    look: {
      kind: "choice",
      label: "Look",
      options: { cards: "Cards: the picture, then the words and buttons", arches: "Tall pictures with a rounded top, each studio's name under its own" },
      start: "cards",
    },
    prices: { kind: "toggle", label: "Show the price per hour", start: true },
    viewLabel: { kind: "text", label: "Words on the button that shows a studio", max: 30, start: "View Studio" },
    bookLabel: { kind: "text", label: "Words on the button that books it", max: 30, start: "Book Now" },
  },
  render: ({ look, prices, viewLabel, bookLabel, site, editing }) => {
    const catalog = site.catalog;
    if (!catalog) return <EditorNote editing={editing}>{MISSING}</EditorNote>;
    if (look === "arches") {
      // As the old website's home page showed the studios: each picture under an arch, the studio's name under it, and
      // the picture and the name leading to the studio. No button shows the studio: the arch does.
      return (
        <ul className="blk studio-arches">
          {catalog.studios.map((studio) => {
            const from = hourlyFromCents(catalog, studio.id);
            const photo = studio.photos[0];
            return (
              <li className="studio-arch" key={studio.id}>
                <SiteAnchor href={`/studios#${studio.slug}`} className="studio-arch-link" editing={editing}>
                  <span className={`studio-arch-img ${studio.slug}-bg`}>
                    {photo ? (
                      <Image className="studio-photo" src={photo.url} width={photo.width} height={photo.height} alt={photo.alt} sizes="(max-width: 700px) 100vw, 400px" quality={85} />
                    ) : (
                      <span className="studio-placeholder-text">{studio.name}</span>
                    )}
                  </span>
                  <span className="studio-arch-name">{studio.name}</span>
                </SiteAnchor>
                {prices && from !== null && <p className="studio-price">From {formatCents(from)}/hour</p>}
                {bookLabel && (
                  <SiteAnchor href={`/book?studio=${studio.slug}`} className="btn btn-outline" editing={editing}>
                    {bookLabel}
                  </SiteAnchor>
                )}
              </li>
            );
          })}
        </ul>
      );
    }
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
                    <div className={`studio-card-img studio-main-photo ${studio.slug}-bg`}>
                      {photo ? (
                        <Image className="studio-photo" src={photo.url} width={photo.width} height={photo.height} alt={photo.alt} sizes="(max-width: 768px) 100vw, 560px" quality={85} loading={index === 0 ? "eager" : "lazy"} />
                      ) : (
                        <span className="studio-placeholder-text">{studio.name}</span>
                      )}
                    </div>
                    {studio.floorPlan && (
                      <figure className="studio-floor-plan">
                        {editing ? (
                          <Image src={studio.floorPlan.url} width={studio.floorPlan.width} height={studio.floorPlan.height} alt={studio.floorPlan.alt} sizes="(max-width: 768px) 100vw, 560px" />
                        ) : (
                          <a href={studio.floorPlan.url} target="_blank" rel="noopener">
                            <Image src={studio.floorPlan.url} width={studio.floorPlan.width} height={studio.floorPlan.height} alt={studio.floorPlan.alt} sizes="(max-width: 768px) 100vw, 560px" />
                          </a>
                        )}
                        <figcaption>Floor plan of {studio.name}</figcaption>
                      </figure>
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
                    {(Object.keys(FACT_LABELS) as (keyof typeof FACT_LABELS)[]).some((name) => studio.facts[name] !== "") && (
                      <dl className="studio-facts">
                        {(Object.keys(FACT_LABELS) as (keyof typeof FACT_LABELS)[])
                          .filter((name) => studio.facts[name] !== "")
                          .map((name) => (
                            <div key={name}>
                              <dt>{FACT_LABELS[name]}</dt>
                              <dd>{studio.facts[name]}</dd>
                            </div>
                          ))}
                      </dl>
                    )}
                    {studio.facts.included.length > 0 && (
                      <>
                        <p className="studio-included-title">Included</p>
                        <ul className="studio-included">
                          {/* By place, not by words: the owners may write one thing twice. */}
                          {studio.facts.included.map((thing, place) => (
                            <li key={place}>{thing}</li>
                          ))}
                        </ul>
                      </>
                    )}
                    {bookLabel && (
                      <SiteAnchor href={`/book?studio=${studio.slug}`} className="btn btn-dark" editing={editing}>
                        {bookLabel} {studio.name.replace(/^Studio /, "")}
                      </SiteAnchor>
                    )}
                  </div>
                </div>
                {/* The studio's other photos, large, in a row across the section that scrolls sideways, as the old
                    website showed them: three and a part of a fourth at once, one at a time on a phone. */}
                {more.length > 0 && (
                  <div className="studio-photo-row">
                    <PictureRow label={`More photos of ${studio.name}`} columns={3.3} columnsPhone={1.15} ratio="1 / 1" count={more.length} listClassName="studio-photo-strip">
                      {more.map((picture) => (
                        <li key={picture.id}>
                          {/* The picture's file opens in a tab of its own: it is not a page, so it is not a link of the router. */}
                          {editing ? (
                            <Image src={picture.url} width={picture.width} height={picture.height} alt={picture.alt} sizes="(max-width: 640px) 90vw, 380px" />
                          ) : (
                            <a href={picture.url} target="_blank" rel="noopener">
                              <Image src={picture.url} width={picture.width} height={picture.height} alt={picture.alt} sizes="(max-width: 640px) 90vw, 380px" />
                            </a>
                          )}
                        </li>
                      ))}
                    </PictureRow>
                  </div>
                )}
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
                      <th scope="col"><span className="visually-hidden">Duration</span></th>
                      <th scope="col" style={{ textAlign: "right" }}>Mon–Fri</th>
                      <th scope="col">Sat–Sun</th>
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

export const MembershipPlans = defineBlock({
  label: "Memberships on sale",
  group: "site",
  fields: {
    joinLabel: { kind: "text", label: "Words on the button that buys one", max: 30, start: "Join" },
    descriptions: { kind: "toggle", label: "Show each plan's description", start: true },
  },
  render: ({ joinLabel, descriptions, site, editing }) => {
    const catalog = site.catalog;
    if (!catalog) return <EditorNote editing={editing}>{MISSING}</EditorNote>;
    if (catalog.membershipPlans.length === 0) {
      return <EditorNote editing={editing}>No membership is offered at the moment, so visitors see nothing here.</EditorNote>;
    }
    const names = new Map(catalog.studios.map((studio) => [studio.id, studio.name]));
    return (
      <div className="blk rates-grid membership-plans">
        {catalog.membershipPlans.map((plan) => (
          <div className="rate-card" key={plan.id}>
            <h3>{plan.name}</h3>
            <div className="rate-price">{formatCents(plan.priceCents)}</div>
            <div className="rate-unit">a month</div>
            <hr className="rate-divider" />
            <p className="membership-plan-hours">{durationLabel(plan.minutes)} of studio time each month</p>
            <p className="membership-plan-where">{plan.studioIds.map((id) => names.get(id)).join(" + ")}</p>
            {descriptions && plan.description && <p className="membership-plan-description">{plan.description}</p>}
            {joinLabel && (
              <SiteAnchor href={`/book/membership?plan=${plan.id}`} className="btn btn-primary mt-2 rate-book" editing={editing}>
                {joinLabel}
              </SiteAnchor>
            )}
          </div>
        ))}
      </div>
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

export const LocationCard = defineBlock({
  label: "Address and map, in a box",
  group: "site",
  fields: {
    sign: { kind: "toggle", label: "A pin above the address", start: true },
    buttonLabel: { kind: "text", label: "Words on the button that opens the map (empty: no button)", max: 30, start: "Open in Maps" },
  },
  render: ({ sign, buttonLabel, site, editing }) => {
    const { business } = site;
    if (!business) return <EditorNote editing={editing}>{MISSING}</EditorNote>;
    return (
      <div className="blk blk-location">
        <div>
          {sign && (
            <div className="blk-location-sign" aria-hidden="true">
              📍
            </div>
          )}
          <p>
            {business.addressLine1}
            <br />
            {business.addressLine2}
          </p>
          {buttonLabel && (
            <SiteAnchor href={business.mapsUrl} className="btn btn-primary" editing={editing}>
              {buttonLabel}
            </SiteAnchor>
          )}
        </div>
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
