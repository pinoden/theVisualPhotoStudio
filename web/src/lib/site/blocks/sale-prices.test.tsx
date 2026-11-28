import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageBlocks } from "@/components/site/PageBlocks";
import type { Sale } from "@/lib/domain/sale";
import { NO_FACTS } from "@/lib/studio-facts";
import type { Catalog } from "@/server/catalog";
import { DEFAULT_SETTINGS } from "@/server/settings";
import { EMPTY_SITE, type SiteContext } from "./block";
import { startProps, type StoredBlock } from "./fields";
import { BLOCKS, type BlockName } from "./registry";

/**
 * A sale on the website's price lists (the owner, 2026-11-27: "I want the price be crossed out, like not 78 but 65"):
 * the usual price crossed out before the sale's, on the Rates page and wherever a studio's hourly price is named.
 */
const B = "id-blanche";
const P = "id-paris";
const hours = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((weekday) => [weekday, { openMinute: 540, closeMinute: 1140 }]));
const studio = (id: string, slug: string, name: string) => ({ id, slug, name, tagline: "", description: "", includedGuests: 6, extraGuests: 6, bufferMinutes: 15, color: "#888888", hours, photos: [], facts: NO_FACTS, floorPlan: null });
const blackFriday: Sale = { id: "sale-1", name: "Black Friday", percent: 17, studioIds: [P], bookFrom: "2026-11-27", bookUntil: "2026-11-28", visitFrom: null, visitUntil: null };
const catalog: Catalog = {
  studios: [studio(B, "blanche", "Studio Blanche"), studio(P, "paris", "Studio Paris")],
  rules: [
    { studioId: B, dayType: "weekday", durationMinutes: 60, priceCents: 8800 },
    { studioId: P, dayType: "weekday", durationMinutes: 60, priceCents: 7800 },
    { studioId: P, dayType: "weekday", durationMinutes: 120, priceCents: 13600 },
    { studioId: P, dayType: "weekend", durationMinutes: 60, priceCents: 9800 },
  ],
  bundlePrices: [
    { studioIds: [B, P], durationMinutes: 60, priceCents: 14000 },
    { studioIds: [B, P], durationMinutes: 120, priceCents: 26000 },
  ],
  addons: [],
  settings: DEFAULT_SETTINGS,
  specialDates: {},
  photoPackages: [],
  accessInfoSent: false,
  membershipPlans: [],
  sales: [blackFriday],
};
const block = (type: BlockName, props: Record<string, unknown> = {}): StoredBlock => ({ type, props: { ...startProps(BLOCKS[type].fields), ...props, id: `${type}-1` } });
const draw = (blocks: StoredBlock[], today: string | undefined, sales: Sale[] = [blackFriday]) =>
  renderToStaticMarkup(<PageBlocks blocks={blocks} site={{ ...EMPTY_SITE, catalog: { ...catalog, sales }, today } as SiteContext} />);
/** A price on sale, as it is drawn: what a screen reader is told, and the usual price struck through. */
const crossed = (usual: string, now: string) =>
  `<span class="visually-hidden">Usual price </span><s class="price-usual">${usual}</s> <span class="visually-hidden">now </span><span class="price-on-sale">${now}</span>`;

describe("a sale on the price lists", () => {
  it("crosses out the usual prices of the studio on sale, on the days it can be booked, and says what is on", () => {
    const html = draw([block("RateCards")], "2026-11-27");
    expect(html).toContain('<p class="sale-note"><strong>Black Friday:</strong> 17% off Studio Paris when you book by Saturday, November 28, 2026.</p>');
    const paris = html.slice(html.indexOf("<h3>Studio Paris</h3>"));
    // $78 an hour is $65, in whole dollars; two hours, $136, are $113; and the weekend's hour, $98, is $81.
    expect(paris).toContain(`<div class="rate-price">${crossed("$78", "$65")}</div>`);
    expect(paris).toContain(`<td style="text-align:right">${crossed("$78", "$65")}</td><td>${crossed("$98", "$81")}</td>`);
    expect(paris).toContain(crossed("$136", "$113"));
    // Blanche is not on sale.
    const blanche = html.slice(html.indexOf("<h3>Studio Blanche</h3>"), html.indexOf("<h3>Studio Paris</h3>"));
    expect(blanche).toContain('<div class="rate-price">$88</div>');
    expect(blanche).not.toContain("<s class");
  });

  it("shows the usual prices the day before it begins, the day after it ends, and to a page that does not know the day", () => {
    for (const today of ["2026-11-26", "2026-11-29", undefined]) {
      const html = draw([block("RateCards")], today);
      expect(html, String(today)).not.toContain("<s class");
      expect(html, String(today)).not.toContain("sale-note");
      expect(html, String(today)).toContain('<div class="rate-price">$78</div>');
    }
  });

  it("says which days of studio time a sale is for, when the owners limit them", () => {
    const weekend = { ...blackFriday, visitFrom: "2026-11-27", visitUntil: "2026-11-29" };
    expect(draw([block("RateCards")], "2026-11-27", [weekend])).toContain(
      "17% off Studio Paris when you book by Saturday, November 28, 2026, for studio time from Friday, November 27, 2026 to Sunday, November 29, 2026.",
    );
  });

  it("crosses out a studio's hourly price wherever a page names it", () => {
    expect(draw([block("StudioDetails")], "2026-11-27")).toContain(`<li>From ${crossed("$78", "$65")} per hour</li>`);
    expect(draw([block("StudioDetails")], "2026-11-29")).toContain("<li>From $78 per hour</li>");
  });

  it("lowers a bundle's prices when each of its studios is on sale, and not while one is not", () => {
    // Paris alone is on sale: Blanche + Paris together cost what they did.
    expect(draw([block("BundlePrices")], "2026-11-27")).not.toContain("<s class");
    const everyStudio = { ...blackFriday, studioIds: [] };
    const html = draw([block("BundlePrices")], "2026-11-27", [everyStudio]);
    expect(html).toContain(`<div class="rate-price">${crossed("$140", "$116")}</div>`);
    expect(html).toContain(`<td>${crossed("$260", "$216")}</td>`);
  });
});
