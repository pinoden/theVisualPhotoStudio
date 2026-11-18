import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageBlocks } from "@/components/site/PageBlocks";
import type { Picture } from "@/server/media";
import { EMPTY_SITE, type SiteContext } from "./block";
import { startProps, type StoredBlock } from "./fields";
import { BLOCKS, type BlockName } from "./registry";

/**
 * Two blocks taken from another studio's website (see "Ideas from another
 * studio's website" in CLAUDE.md): reviews, and a row of the logos of the
 * brands the studio has worked for. Drawn as visitors get them.
 */

/** A block as a page stores it: its starting values, with these instead. */
const block = (type: BlockName, props: Record<string, unknown> = {}): StoredBlock => ({
  type,
  props: { ...startProps(BLOCKS[type].fields), ...props, id: `${type}-1` },
});
const drawn = (blocks: StoredBlock[], site: SiteContext = EMPTY_SITE) => renderToStaticMarkup(<PageBlocks blocks={blocks} site={site} />);

describe("the reviews block", () => {
  it("starts with nothing a visitor could take for a review", () => {
    expect(drawn([block("Reviews")])).toBe("");
  });

  it("shows what clients wrote, with their name, where they wrote it and their stars, and leaves out a review without words", () => {
    const html = drawn([
      block("Reviews", {
        reviews: [
          { quote: "Beautiful light.\nWe will be back.", name: "Ana R.", source: "Google", stars: "5" },
          { quote: "", name: "Never written", source: "", stars: "4" },
          { quote: "\u200B\u2060\u200E\u00AD\u3164\u2800", name: "Invisible", source: "", stars: "5" },
          { quote: "A great space for a team shoot.", name: "Marco", source: "", stars: "none" },
        ],
      }),
    ]);
    expect(html).toContain("<blockquote><p>Beautiful light.\nWe will be back.</p></blockquote>");
    expect(html).toContain("<figcaption>Ana R., <cite>Google</cite></figcaption>");
    expect(html).toContain('<span aria-hidden="true">★★★★★</span><span class="visually-hidden">5 out of 5 stars</span>');
    expect(html).toContain("<figcaption>Marco</figcaption>");
    expect(html.match(/blk-review-stars/g)).toHaveLength(1);
    expect(html).not.toContain("Never written");
    expect(html).not.toContain("Invisible");
    // Two reviews take two columns, not two of three.
    expect(html).toContain('style="--cols:2"');
    expect(html).not.toContain("data-wide");
  });

  it("names where a review was written even without a name, and shows fewer stars as empty ones", () => {
    const html = drawn([block("Reviews", { reviews: [{ quote: "Lovely.", name: "", source: "Yelp", stars: "4" }] })]);
    expect(html).toContain("<figcaption><cite>Yelp</cite></figcaption>");
    // Alone in its row, it is kept as wide as a line can be read.
    expect(html).toContain('data-wide="true"');
    expect(html).toContain('<span aria-hidden="true">★★★★☆</span><span class="visually-hidden">4 out of 5 stars</span>');
  });
});

describe("the logos block", () => {
  const north = "0b2c4d6e-8f10-4a2b-9c3d-4e5f6a7b8c01";
  const bloom = "0b2c4d6e-8f10-4a2b-9c3d-4e5f6a7b8c02";
  const deleted = "0b2c4d6e-8f10-4a2b-9c3d-4e5f6a7b8c03";
  const logo = (id: string, alt: string): Picture => ({ id, url: `/media/${id}/1/logo.png`, width: 480, height: 160, alt, caption: "" });
  const site: SiteContext = { ...EMPTY_SITE, pictures: { [north]: logo(north, "Logo of North Apparel"), [bloom]: logo(bloom, "Logo of Bloom Beauty") } };

  it("shows nothing until its pictures are chosen", () => {
    expect(drawn([block("Logos")], site)).toBe("");
  });

  it("shows the chosen pictures in their order, each named by what the library says it shows, and leaves out one that was deleted", () => {
    const html = drawn([block("Logos", { logos: [bloom, deleted, north], height: "large", look: "grey" })], site);
    expect(html).toContain('<ul class="blk blk-logos" data-height="large" data-look="grey">');
    expect([...html.matchAll(/alt="([^"]*)"/g)].map((match) => match[1])).toEqual(["Logo of Bloom Beauty", "Logo of North Apparel"]);
  });
});
