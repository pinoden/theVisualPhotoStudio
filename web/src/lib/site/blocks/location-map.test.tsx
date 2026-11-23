import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageBlocks } from "@/components/site/PageBlocks";
import type { Picture } from "@/server/media";
import { EMPTY_SITE, type SiteContext } from "./block";
import { startProps, type StoredBlock } from "./fields";
import { BLOCKS } from "./registry";

/**
 * The address box's picture of the map (the owners' note 3 of 2026-11-22, and the owner's answer of 2026-11-23: a map
 * picture first; question 74 in ProjectLibrary.md): a picture of the library, which opens the map when pressed.
 */
const MAP = "11111111-2222-4333-8444-555555555555";
const picture: Picture = { id: MAP, url: `/media/${MAP}/1/map.png`, width: 1200, height: 700, alt: "Map of Winter Park with the studio marked on Park Avenue", caption: "" };
const business = { name: "The Visuals Photo Studio", addressLine1: "1 Park Ave", addressLine2: "Winter Park, FL 32789", phone: "407-555-0100", mapsUrl: "https://maps.example/studio", note: "" };
const site = { ...EMPTY_SITE, pictures: { [MAP]: picture }, business } as SiteContext;
const box = (props: Record<string, unknown> = {}): StoredBlock => ({ type: "LocationCard", props: { ...startProps(BLOCKS.LocationCard.fields), ...props, id: "LocationCard-1" } });
const drawn = (blocks: StoredBlock[]) => renderToStaticMarkup(<PageBlocks blocks={blocks} site={site} />);

describe("the address box's picture of the map", () => {
  it("is not there until the owners choose one, as the box was", () => {
    const html = drawn([box()]);
    expect(html).toContain('class="blk blk-location"');
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://maps.example/studio"'); // the button, as before
  });

  it("shows the picture chosen, which opens the map, above the address and the button", () => {
    const html = drawn([box({ map: MAP })]);
    expect(html).toContain('class="blk blk-location blk-location-with-map"');
    expect(html).toMatch(/<a href="https:\/\/maps\.example\/studio" class="blk-location-map" target="_blank" rel="noopener noreferrer"><img alt="Map of Winter Park with the studio marked on Park Avenue"/);
    expect(html.indexOf("blk-location-map")).toBeLessThan(html.indexOf("1 Park Ave"));
  });

  it("leaves out a picture deleted from the library", () => {
    expect(drawn([box({ map: "99999999-2222-4333-8444-555555555555" })])).not.toContain("<img");
  });
});
