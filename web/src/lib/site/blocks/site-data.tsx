import Image from "next/image";
import { ContactForm as ContactFormView } from "@/components/ContactForm";
import { PictureRow } from "@/components/site/PictureRow";
import { SalePrice } from "@/components/SalePrice";
import { bundleName, bundleTables, catalogOnSale, hasWeekendPricing, hourlyFromCents, hoursLines, openingHours, priceTable } from "@/lib/catalog-view";
import { formatCents } from "@/lib/domain/pricing";
import { saleCodesWords, saleWords, type Sale } from "@/lib/domain/sale";
import { sessionsOf } from "@/lib/domain/services";
import { durationLabel } from "@/lib/domain/time";
import { FACT_LABELS, sectionParts } from "@/lib/studio-facts";
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
    const { shown } = catalogOnSale(catalog, site.today);
    if (look === "arches") {
      // As the old website's home page showed the studios: each picture under an arch, the studio's name under it, and
      // the picture and the name leading to the studio. No button shows the studio: the arch does.
      return (
        <ul className="blk studio-arches">
          {catalog.studios.map((studio) => {
            const from = hourlyFromCents(shown, studio.id);
            const usualFrom = hourlyFromCents(catalog, studio.id);
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
                {prices && from !== null && (
                  <p className="studio-price">
                    From <SalePrice cents={from} usual={usualFrom} />
                    /hour
                  </p>
                )}
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
          const from = hourlyFromCents(shown, studio.id);
          const usualFrom = hourlyFromCents(catalog, studio.id);
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
                {prices && from !== null && (
                  <p className="studio-price">
                    From <SalePrice cents={from} usual={usualFrom} />
                    /hour
                  </p>
                )}
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
    const { shown } = catalogOnSale(catalog, site.today);
    return (
      <div className="blk blk-studio-details">
        {catalog.studios.map((studio, index) => {
          const from = hourlyFromCents(shown, studio.id);
          const usualFrom = hourlyFromCents(catalog, studio.id);
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
                      {from !== null && (
                        <li>
                          From <SalePrice cents={from} usual={usualFrom} /> per hour
                        </li>
                      )}
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
                    {studio.facts.sections.length > 0 && (
                      <div className="studio-sections">
                        {studio.facts.sections.map((section, place) => (
                          // Open in the editor, so that what each says can be read there.
                          <details className="studio-section" key={place} open={editing || undefined}>
                            <summary>{section.title}</summary>
                            <div className="studio-section-body">
                              {sectionParts(section.text).map((part, at) =>
                                part.kind === "list" ? (
                                  <ul key={at}>
                                    {part.items.map((item, i) => (
                                      <li key={i}>{item}</li>
                                    ))}
                                  </ul>
                                ) : (
                                  <p key={at}>{part.text}</p>
                                ),
                              )}
                            </div>
                          </details>
                        ))}
                      </div>
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

const BETWEEN_NOTE = "Need a different length? Every studio and bundle can be booked for {booking lengths}: the booking page shows the price of each.";

/** The sales on now, above a price list: each says what comes off, until when, and for which days. */
function SaleNotes({ sales, catalog }: { sales: Sale[]; catalog: { studios: { id: string; name: string }[] } }) {
  if (sales.length === 0) return null;
  return (
    <div className="sale-notes">
      {sales.map((sale) => (
        <p className="sale-note" key={sale.id}>
          <strong>{sale.name}:</strong> {saleWords(sale, catalog.studios)}.{saleCodesWords(sale)}
        </p>
      ))}
    </div>
  );
}

export const RateCards = defineBlock({
  label: "Prices of the studios",
  group: "site",
  fields: {
    bookLabel: { kind: "text", label: "Words on the booking button", max: 30, start: "Book Now" },
    /** Shown only while the owners sell lengths besides the listed ones (Admin → Prices). */
    betweenNote: {
      kind: "text",
      label: "A line under the prices, while lengths besides the listed ones can be booked (empty: none)",
      max: 240,
      start: BETWEEN_NOTE,
    },
  },
  render: ({ bookLabel, betweenNote, site, editing }) => {
    const catalog = site.catalog;
    if (!catalog) return <EditorNote editing={editing}>{MISSING}</EditorNote>;
    const { shown, sales } = catalogOnSale(catalog, site.today);
    const weekend = hasWeekendPricing(catalog);
    return (
      <>
        {/* Above the cards, not among them: a line across the grid would keep a column the cards do not fill. */}
        <SaleNotes sales={sales} catalog={catalog} />
        <div className="blk rates-grid">
          {catalog.studios.map((studio) => {
            const from = hourlyFromCents(shown, studio.id);
            const usualFrom = hourlyFromCents(catalog, studio.id);
            const usualRows = priceTable(catalog, studio.id);
            return (
              <div className="rate-card" key={studio.id}>
                <h3>{studio.name}</h3>
                {from !== null && (
                  <>
                    <div className="rate-price">
                      <SalePrice cents={from} usual={usualFrom} />
                    </div>
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
                    {priceTable(shown, studio.id).map((row, index) => {
                      // The same lengths in the same order: a sale lowers prices and takes none away.
                      const usual = usualRows[index];
                      const last = weekend ? row.weekendCents : row.weekdayCents;
                      return (
                        <tr key={row.durationMinutes}>
                          <td style={{ textAlign: "left" }}>{durationLabel(row.durationMinutes)}</td>
                          {weekend && <td style={{ textAlign: "right" }}>{row.weekdayCents === null ? "—" : <SalePrice cents={row.weekdayCents} usual={usual?.weekdayCents} />}</td>}
                          <td>{last === null ? "—" : <SalePrice cents={last} usual={weekend ? usual?.weekendCents : usual?.weekdayCents} />}</td>
                        </tr>
                      );
                    })}
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
        {/* Below the cards, not among them, for the same reason (it was among them from 2026-11-25 to 2026-11-28). */}
        {betweenNote && [...catalog.rules, ...catalog.bundlePrices].some((row) => row.between) && <p className="rates-note">{betweenNote}</p>}
      </>
    );
  },
});

/**
 * The bundles' prices (the owner's brief of 2026-11-24, item 4, and answers of 2026-11-25): a card for each bundle the
 * owners gave prices of its own under Admin → Prices, with the price of each length they list. A bundle costs the same
 * on every day, so there is one column. Nothing while no bundle has prices: a bundle is then a percentage off the
 * studios' prices, which the pages say in words (`{several studios offer}`).
 */
export const BundlePrices = defineBlock({
  label: "Prices of the bundles",
  group: "site",
  fields: {
    bookLabel: { kind: "text", label: "Words on the booking button", max: 30, start: "Book Now" },
  },
  render: ({ bookLabel, site, editing }) => {
    const catalog = site.catalog;
    if (!catalog) return <EditorNote editing={editing}>{MISSING}</EditorNote>;
    const tables = bundleTables(catalog);
    const { shown } = catalogOnSale(catalog, site.today);
    const onSale = new Map(bundleTables(shown).map((table) => [table.studioIds.join("+"), table]));
    if (tables.length === 0) {
      return <EditorNote editing={editing}>No bundle has prices of its own under Admin → Prices, so visitors see nothing here.</EditorNote>;
    }
    const studios = new Map(catalog.studios.map((studio) => [studio.id, studio]));
    return (
      <div className="blk rates-grid bundle-prices">
        {tables.map((table) => {
          const members = table.studioIds.flatMap((id) => studios.get(id) ?? []);
          // The same lengths in the same order as the usual prices: a sale lowers prices and takes none away.
          const sold = onSale.get(table.studioIds.join("+"))?.prices ?? table.prices;
          const hourAt = table.prices.findIndex((price) => price.durationMinutes === 60);
          const hour = hourAt < 0 ? null : table.prices[hourAt];
          const guests = members.reduce((sum, studio) => sum + studio.includedGuests, 0);
          return (
            <section className="rate-card" key={table.studioIds.join("+")} aria-label={table.name}>
              <h3>{table.name}</h3>
              {hour && (
                <>
                  <div className="rate-price">
                    <SalePrice cents={sold[hourAt].priceCents} usual={hour.priceCents} />
                  </div>
                  <div className="rate-unit">per hour</div>
                </>
              )}
              <hr className="rate-divider" />
              <table className="price-table">
                <tbody>
                  {table.prices.map((price, index) => (
                    <tr key={price.durationMinutes}>
                      <td style={{ textAlign: "left" }}>{durationLabel(price.durationMinutes)}</td>
                      <td>
                        <SalePrice cents={sold[index].priceCents} usual={price.priceCents} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ fontSize: ".8rem", marginTop: "1rem" }}>Up to {guests} guests included.</p>
              {bookLabel && (
                <SiteAnchor
                  href={`/book?studio=${members.map((studio) => studio.slug).join(",")}`}
                  className="btn btn-primary mt-2 rate-book"
                  editing={editing}
                  label={`${bookLabel}: ${table.name}`}
                >
                  {bookLabel}
                </SiteAnchor>
              )}
            </section>
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

/** Whose sessions a block lists. */
const SESSION_SERVICES = { photography: "Photography", content: "Content creation" } as const;

/**
 * The sessions with the in-house photographer (or content creator) and their prices, a card for each studio they are
 * in (the owner's brief of 2026-11-24, item 4: "Add pricing and package details for professional photography ... Ensure
 * the displayed prices match the actual booking prices"). Read from the sessions on sale (Admin → Photography), so they
 * are always what a booking costs.
 */
export const SessionPrices = defineBlock({
  label: "Photography sessions and their prices",
  group: "site",
  fields: {
    service: { kind: "choice", label: "Whose sessions", options: SESSION_SERVICES, start: "photography" },
    bookLabel: { kind: "text", label: "Words on the booking button (empty: no button)", max: 30, start: "Book a Session" },
  },
  render: ({ service, bookLabel, site, editing }) => {
    const catalog = site.catalog;
    if (!catalog) return <EditorNote editing={editing}>{MISSING}</EditorNote>;
    const sessions = sessionsOf(catalog.photoPackages, service);
    const studios = catalog.studios.filter((studio) => sessions.some((session) => session.studioId === studio.id));
    if (studios.length === 0) return <EditorNote editing={editing}>No {SESSION_SERVICES[service].toLowerCase()} session is on sale, so visitors see nothing here.</EditorNote>;
    return (
      <div className="blk rates-grid session-prices">
        {studios.map((studio) => {
          const own = sessions.filter((session) => session.studioId === studio.id).sort((a, b) => a.durationMinutes - b.durationMinutes);
          return (
            <section className="rate-card" key={studio.id} aria-label={`${SESSION_SERVICES[service]} in ${studio.name}`}>
              <h3>{studio.name}</h3>
              <div className="rate-unit">Sessions from</div>
              <div className="rate-price">{formatCents(Math.min(...own.map((session) => session.priceCents)))}</div>
              <div className="rate-unit">studio rental included</div>
              <hr className="rate-divider" />
              <table className="price-table session-price-table">
                <thead>
                  <tr>
                    <th scope="col">Session</th>
                    <th scope="col">Price</th>
                  </tr>
                </thead>
                <tbody>
                  {own.map((session) => (
                    <tr key={session.id}>
                      <td style={{ textAlign: "left" }}>
                        {durationLabel(session.durationMinutes)}
                        {session.includes && <span className="session-includes">{session.includes}</span>}
                      </td>
                      <td>{formatCents(session.priceCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {bookLabel && (
                <SiteAnchor href={`/book/${service === "content" ? "content" : "photography"}?studio=${studio.slug}`} className="btn btn-primary mt-2 rate-book" editing={editing} label={`${bookLabel}: ${studio.name}`}>
                  {bookLabel}
                </SiteAnchor>
              )}
            </section>
          );
        })}
      </div>
    );
  },
});

/** The benefits each membership shows, as the owner's brief of 2026-11-24 (item 6) lists them; the owners change them in the page editor. */
const MEMBERSHIP_BENEFITS = [
  "Discounted studio rental rates.",
  "Hours can be used on weekdays and weekends.",
  "Members can split their hours across multiple appointments.",
  "Unused hours roll over to the following month.",
  "No minimum commitment.",
  "Members can cancel their subscription at any time.",
  "Unused hours remain available after membership cancellation.",
].map((text) => ({ text }));

/**
 * The memberships on sale (the owner's brief of 2026-11-24, item 6): one card for each studio or bundle, with each of its
 * plans' monthly price, hours and price an hour, and a button that buys it; then the benefits, and a link to the terms.
 * The plans, their prices and descriptions are the owners', under Admin → Memberships.
 */
export const MembershipPlans = defineBlock({
  label: "Memberships on sale",
  group: "site",
  fields: {
    joinLabel: { kind: "text", label: "Words on the button that buys one", max: 30, start: "Join" },
    descriptions: { kind: "toggle", label: "Show each plan's description", start: true },
    hourly: { kind: "toggle", label: "Show each plan's price an hour", start: true },
    benefitsTitle: { kind: "text", label: "Heading above the benefits (empty: no heading)", max: 60, start: "Membership benefits" },
    benefits: {
      kind: "list",
      label: "Benefits, on every card",
      max: 12,
      title: "text",
      of: { text: { kind: "text", label: "A benefit", max: 160, start: "A benefit." } },
      start: MEMBERSHIP_BENEFITS,
    },
    termsLabel: { kind: "text", label: "Words of the link to the terms (empty: no link)", max: 40, start: "Membership terms" },
    /** Empty, the memberships page's terms: a block saved before this field had none (a link left out reads as ""). */
    termsLink: { kind: "link", label: "Where the terms are (empty: the memberships page's terms)", start: "/memberships#terms" },
  },
  render: ({ joinLabel, descriptions, hourly, benefitsTitle, benefits, termsLabel, termsLink, site, editing }) => {
    const catalog = site.catalog;
    if (!catalog) return <EditorNote editing={editing}>{MISSING}</EditorNote>;
    if (catalog.membershipPlans.length === 0) {
      return <EditorNote editing={editing}>No membership is offered at the moment, so visitors see nothing here.</EditorNote>;
    }
    const studios = new Map(catalog.studios.map((studio) => [studio.id, studio]));
    // The plans by the studios they are for, in the owners' order of plans; within each, the fewest hours first.
    const groups = new Map<string, typeof catalog.membershipPlans>();
    for (const plan of catalog.membershipPlans) {
      const key = plan.studioIds.join(",");
      groups.set(key, [...(groups.get(key) ?? []), plan]);
    }
    const shown = benefits.filter((benefit) => benefit.text !== "");
    const nameOf = (ids: string[]) => bundleName(catalog, ids);
    return (
      <div className="blk rates-grid membership-plans">
        {[...groups.values()].map((plans) => {
          const ids = plans[0].studioIds;
          const name = nameOf(ids);
          return (
            <section className="rate-card membership-group" key={ids.join(",")} aria-label={name}>
              <h3>{name}</h3>
              {ids.length > 1 && <p className="membership-plan-where">{ids.map((id) => studios.get(id)?.name).join(" + ")}</p>}
              <ul className="membership-options">
                {[...plans]
                  .sort((a, b) => a.minutes - b.minutes)
                  .map((plan) => (
                    <li className="membership-option" key={plan.id}>
                      <p className="membership-plan-hours">{durationLabel(plan.minutes)} a month</p>
                      <p className="membership-option-price">
                        <span className="rate-price">{formatCents(plan.priceCents)}</span> <span className="rate-unit">a month</span>
                      </p>
                      {hourly && <p className="membership-option-hourly">{formatCents(Math.round((plan.priceCents * 60) / plan.minutes))} an hour</p>}
                      {descriptions && plan.description && <p className="membership-plan-description">{plan.description}</p>}
                      {joinLabel && (
                        <SiteAnchor href={`/book/membership?plan=${plan.id}`} className="btn btn-primary rate-book" editing={editing} label={`${joinLabel}: ${plan.name}`}>
                          {joinLabel}
                        </SiteAnchor>
                      )}
                    </li>
                  ))}
              </ul>
              {shown.length > 0 && (
                <div className="membership-benefits">
                  {benefitsTitle && <p className="membership-benefits-title">{benefitsTitle}</p>}
                  <ul>
                    {shown.map((benefit, place) => (
                      <li key={place}>{benefit.text}</li>
                    ))}
                  </ul>
                </div>
              )}
              {termsLabel && (
                <SiteAnchor href={termsLink || "/memberships#terms"} className="membership-terms-link" editing={editing}>
                  {termsLabel}
                </SiteAnchor>
              )}
            </section>
          );
        })}
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
    /**
     * A picture of the map, from the media library (the owners' note 3 of 2026-11-22, and the owner's answer of
     * 2026-11-23: a map picture first; question 74 in ProjectLibrary.md). Pressed, it opens the map. A picture, not a
     * live map: nothing loads from another service until the visitor presses.
     */
    map: { kind: "picture", label: "A picture of the map (from the media library, its map's credit in it); pressed, it opens the map" },
  },
  render: ({ sign, buttonLabel, map, site, editing }) => {
    const { business } = site;
    if (!business) return <EditorNote editing={editing}>{MISSING}</EditorNote>;
    const picture = map ? site.pictures[map] : undefined;
    return (
      <div className={`blk blk-location${picture ? " blk-location-with-map" : ""}`}>
        {picture && (
          <SiteAnchor href={business.mapsUrl} className="blk-location-map" editing={editing}>
            <Image src={picture.url} width={picture.width} height={picture.height} alt={picture.alt} sizes="(max-width: 640px) 100vw, 560px" />
          </SiteAnchor>
        )}
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
