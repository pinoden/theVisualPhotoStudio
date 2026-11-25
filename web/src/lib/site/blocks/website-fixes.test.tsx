import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageBlocks } from "@/components/site/PageBlocks";
import { NO_FACTS } from "@/lib/studio-facts";
import type { Catalog } from "@/server/catalog";
import { DEFAULT_SETTINGS } from "@/server/settings";
import { EMPTY_SITE, type SiteContext } from "./block";
import { startProps, type StoredBlock } from "./fields";
import { BLOCKS, type BlockName } from "./registry";

/**
 * The blocks the owner's brief of 2026-11-24 ("Website Fixes", in ProjectLibrary.md) changed or added: cards that are
 * links (item 2), each studio's sections (item 1), photography's sessions and prices (item 4), and the memberships by
 * studio with their price an hour, benefits and terms (item 6).
 */
const B = "id-blanche";
const D = "id-dayglow";
const P = "id-paris";
const hours = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((weekday) => [weekday, { openMinute: 540, closeMinute: 1140 }]));
const studio = (id: string, slug: string, name: string) => ({ id, slug, name, tagline: "", description: "", includedGuests: 6, extraGuests: 6, bufferMinutes: 15, color: "#888888", hours, photos: [], facts: NO_FACTS, floorPlan: null });
const plan = (id: string, name: string, studioIds: string[], hoursAMonth: number, dollars: number) => ({ id, name, description: "", minutes: hoursAMonth * 60, priceCents: dollars * 100, studioIds });

const catalog: Catalog = {
  studios: [
    {
      ...studio(B, "blanche", "Studio Blanche"),
      facts: {
        ...NO_FACTS,
        sections: [
          { title: "Furniture", text: "- Brown leather statement couch\n- White side table" },
          { title: "Pets", text: "Pets are not allowed in Studio Blanche." },
        ],
      },
    },
    studio(D, "dayglow", "Studio Dayglow"),
    studio(P, "paris", "Studio Paris"),
  ],
  rules: [],
  bundlePrices: [],
  addons: [],
  settings: DEFAULT_SETTINGS,
  specialDates: {},
  photoPackages: [
    { id: "p-120", service: "photography", studioId: P, durationMinutes: 120, priceCents: 51500, includes: "2–3 outfits, 30 edited images" },
    { id: "p-60", service: "photography", studioId: P, durationMinutes: 60, priceCents: 31500, includes: "1–2 outfits, 20 edited images" },
    { id: "b-60", service: "photography", studioId: B, durationMinutes: 60, priceCents: 37500, includes: "" },
    { id: "c-60", service: "content", studioId: D, durationMinutes: 60, priceCents: 20000, includes: "Reels" },
  ],
  accessInfoSent: false,
  membershipPlans: [
    plan("m-p10", "Studio Paris, 10 hours a month", [P], 10, 550),
    plan("m-p5", "Studio Paris, 5 hours a month", [P], 5, 300),
    plan("m-pd5", "Paris and Dayglow, 5 hours a month", [P, D], 5, 520),
    plan("m-all5", "All three studios, 5 hours a month", [P, D, B], 5, 780),
  ],
};
const site = { ...EMPTY_SITE, catalog } as SiteContext;
const block = (type: BlockName, props: Record<string, unknown> = {}): StoredBlock => ({ type, props: { ...startProps(BLOCKS[type].fields), ...props, id: `${type}-1` } });
const drawn = (blocks: StoredBlock[]) => renderToStaticMarkup(<PageBlocks blocks={blocks} site={site} />);

describe("the website fixes of 2026-11-24", () => {
  it("make a card with a link one link, all of it, and leave a card without one as it was", () => {
    const html = drawn([
      block("Cards", {
        cards: [
          { symbol: "✦", title: "Know the time?", text: "Pick a date first.", link: "/book?by=date" },
          { symbol: "✦", title: "Need more space?", text: "Bundles.", link: "" },
        ],
      }),
    ]);
    expect(html).toMatch(/<div class="blk-card"><a class="blk-card-link" href="\/book\?by=date"><div class="blk-card-symbol" aria-hidden="true">✦<\/div><h4>Know the time\?<\/h4><p>Pick a date first\.<\/p><\/a><\/div>/);
    expect(html).toContain('<div class="blk-card"><div class="blk-card-symbol" aria-hidden="true">✦</div><h4>Need more space?</h4>');
  });

  it("show each studio's sections, each opened by its title, a line starting \"- \" a point of a list", () => {
    const html = drawn([block("StudioDetails")]);
    expect(html).toContain('<details class="studio-section"><summary>Furniture</summary><div class="studio-section-body"><ul><li>Brown leather statement couch</li><li>White side table</li></ul></div></details>');
    expect(html).toContain("<summary>Pets</summary>");
    expect(html.match(/class="studio-sections"/g)).toHaveLength(1); // Dayglow and Paris have none
  });

  it("list the photography sessions by studio, shortest first, with what they include and a button to book there", () => {
    const html = drawn([block("SessionPrices")]);
    expect(html).toContain('aria-label="Photography in Studio Blanche"');
    expect(html).toContain('aria-label="Photography in Studio Paris"');
    expect(html).not.toContain("Studio Dayglow"); // its only session is content creation's
    const paris = html.slice(html.indexOf("Photography in Studio Paris"));
    expect(paris.indexOf("1 hour")).toBeLessThan(paris.indexOf("2 hours"));
    expect(paris).toContain('<span class="session-includes">1–2 outfits, 20 edited images</span>');
    expect(paris).toContain("$315");
    expect(paris).toContain('href="/book/photography?studio=paris"');
    expect(drawn([block("SessionPrices", { service: "content" })])).toContain('href="/book/content?studio=dayglow"');
  });

  it("put each studio's or bundle's memberships on one card, with the price an hour, the benefits and the terms", () => {
    const html = drawn([block("MembershipPlans", { termsLink: "" })]);
    const cards = html.match(/<section class="rate-card membership-group"[^>]*aria-label="([^"]+)"/g)?.map((tag) => /aria-label="([^"]+)"/.exec(tag)![1]);
    expect(cards).toEqual(["Studio Paris", "Paris + Dayglow", "All three studios"]);
    const paris = html.slice(0, html.indexOf('aria-label="Paris + Dayglow"'));
    expect(paris.indexOf("5 hours a month")).toBeLessThan(paris.indexOf("10 hours a month"));
    expect(paris).toContain("$60 an hour"); // $300 for 5 hours
    expect(paris).toContain("$55 an hour"); // $550 for 10 hours
    expect(paris).toContain('aria-label="Join: Studio Paris, 5 hours a month"');
    expect(paris).toContain("Unused hours remain available after membership cancellation.");
    // A block saved before the terms' link existed leads to the memberships page's terms.
    expect(paris).toContain('<a class="membership-terms-link" href="/memberships#terms">Membership terms</a>');
    expect(drawn([block("MembershipPlans", { hourly: false, benefits: [], termsLabel: "" })])).not.toMatch(/an hour|membership-benefits|membership-terms-link/);
  });
});

describe("the bundles' prices (the brief's item 4; the owner's answers of 2026-11-25)", () => {
  const bundlePrices = [
    { studioIds: [B, D, P], durationMinutes: 60, priceCents: 18000 },
    { studioIds: [D, P], durationMinutes: 120, priceCents: 23000 },
    { studioIds: [D, P], durationMinutes: 60, priceCents: 11500 },
    { studioIds: [D, P], durationMinutes: 90, priceCents: 17300, between: true as const },
  ];
  const withBundles = { ...site, catalog: { ...catalog, bundlePrices } } as SiteContext;
  const draw = (blocks: StoredBlock[], context: SiteContext = withBundles) => renderToStaticMarkup(<PageBlocks blocks={blocks} site={context} />);

  it("are a card for each bundle, with the lengths the owners list, the guests included and a button that books it", () => {
    const html = draw([block("BundlePrices")]);
    const cards = html.match(/<section class="rate-card" aria-label="([^"]+)"/g)?.map((tag) => /aria-label="([^"]+)"/.exec(tag)![1]);
    expect(cards).toEqual(["Paris + Dayglow", "All three studios"]);
    const two = html.slice(0, html.indexOf('aria-label="All three studios"'));
    expect(two).toContain('<div class="rate-price">$115</div><div class="rate-unit">per hour</div>');
    expect(two).toMatch(/<td[^>]*>1 hour<\/td><td>\$115<\/td>.*<td[^>]*>2 hours<\/td><td>\$230<\/td>/);
    expect(two).not.toContain("1.5 hours"); // a length between is booked, not listed
    expect(two).toContain("Up to 12 guests included."); // six each
    expect(two).toContain('href="/book?studio=dayglow,paris"');
    expect(two).toContain('aria-label="Book Now: Paris + Dayglow"');
  });

  it("show visitors nothing while no bundle has prices", () => {
    expect(draw([block("BundlePrices")], site)).toBe("");
  });

  it("say under the studios' prices that other lengths can be booked, while the owners sell them", () => {
    const note = "Need a different length? Every studio and bundle can be booked for {booking lengths}";
    expect(draw([block("RateCards")])).toContain(`<p class="rates-note">${note}`);
    const listedOnly = { ...site, catalog: { ...catalog, rules: catalog.rules.filter((rule) => !rule.between), bundlePrices: catalog.bundlePrices.filter((price) => !price.between) } } as SiteContext;
    expect(draw([block("RateCards")], listedOnly)).not.toContain("rates-note");
    expect(draw([block("RateCards", { betweenNote: "" })])).not.toContain("rates-note");
  });
});
