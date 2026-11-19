import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PageBlocks } from "@/components/site/PageBlocks";
import type { Catalog } from "@/server/catalog";
import { loadCatalog } from "@/server/catalog";
import type { Picture } from "@/server/media";
import { createTestWorld, type TestWorld } from "@/server/testing";
import { EMPTY_SITE, type SiteContext } from "./block";
import { startProps, type StoredBlock } from "./fields";
import { BLOCKS, type BlockName } from "./registry";

/**
 * How the old website (Squarespace) showed its pictures, which the blocks can
 * now show the same way: a picture across a title band, with the words over
 * it; a gallery in one row that scrolls sideways; the studios as arches; and a
 * studio's photos large, in a row, instead of small ones under its first.
 */

const block = (type: BlockName, props: Record<string, unknown> = {}): StoredBlock => ({
  type,
  props: { ...startProps(BLOCKS[type].fields), ...props, id: `${type}-1` },
});
const drawn = (blocks: StoredBlock[], site: SiteContext = EMPTY_SITE) => renderToStaticMarkup(<PageBlocks blocks={blocks} site={site} />);

const id = (n: number) => `0b2c4d6e-8f10-4a2b-9c3d-4e5f6a7b8c${String(n).padStart(2, "0")}`;
const photo = (n: number, alt = `Photo ${n}`): Picture => ({ id: id(n), url: `/media/${id(n)}/1/photo-${n}.jpg`, width: 2500, height: 1667, alt, caption: "" });
const library = (count: number): Record<string, Picture> => Object.fromEntries(Array.from({ length: count }, (_, n) => [id(n + 1), photo(n + 1)]));

describe("a title band with a picture behind it", () => {
  const site: SiteContext = { ...EMPTY_SITE, pictures: { [id(1)]: photo(1, "Studio Paris: a cream sofa by a white mantel") } };

  it("fills the hero with the picture, asked for at once, with the words over it", () => {
    const html = drawn([block("Banner", { look: "hero", title: "Where Every Frame", picture: id(1), focus: "bottom", focusPhone: "left" })], site);
    expect(html).toContain('<section class="blk blk-banner hero has-picture">');
    expect(html).toContain('alt="Studio Paris: a cream sofa by a white mantel"');
    expect(html).toContain('class="blk-banner-picture"');
    expect(html).toContain('loading="eager"');
    expect(html).toContain('fetchPriority="high"');
    expect(html).toContain('sizes="100vw"');
    // What stays in view when it is cropped, on a computer and on a phone.
    expect(html).toContain("--focus:bottom");
    expect(html).toContain("--focus-phone:left");
    // The words come after the picture, so they are drawn over it.
    expect(html.indexOf("blk-banner-picture")).toBeLessThan(html.indexOf("Where Every Frame"));
  });

  it("puts a page's title over its picture, and is as it was without one", () => {
    const pictured = drawn([block("Banner", { title: "Studio Rates", picture: id(1) })], site);
    expect(pictured).toContain('<div class="blk blk-banner page-banner has-picture">');
    expect(pictured).toContain('<div class="page-banner-content"><h1>Studio Rates</h1>');
    expect(pictured).not.toContain("--focus-phone");

    const plain = drawn([block("Banner", { title: "Studio Rates" })], site);
    expect(plain).toBe('<div class="blk blk-banner page-banner"><h1>Studio Rates</h1></div>');
  });

  it("shows no picture for one that left the library", () => {
    const html = drawn([block("Banner", { look: "hero", title: "Welcome", picture: id(9) })], site);
    expect(html).not.toContain("has-picture");
    expect(html).not.toContain("<img");
  });
});

describe("a gallery in one row that scrolls sideways", () => {
  const site: SiteContext = { ...EMPTY_SITE, pictures: library(5) };
  const chosen = [1, 2, 3, 4, 5].map(id);

  it("shows its pictures in one row marked as made to scroll sideways, with arrows when not all of them show at once", () => {
    const html = drawn([block("Gallery", { pictures: chosen, layout: "row", columns: 3, shape: "tall" })], site);
    expect(html).toContain('class="picture-row" data-arrows="" data-arrows-phone=""');
    // One at a time on a phone, unless a number was chosen for phones.
    expect(html).toContain("--cols:3;--cols-phone:1;--ratio:4 / 5");
    expect(html).toContain('<ul class="picture-row-list blk-gallery-row" data-gap="normal" data-scrolls-sideways="" aria-label="Pictures">');
    expect(html.match(/<li>/g)).toHaveLength(5);
    expect(html).toContain('aria-label="Previous pictures"');
    expect(html).toContain('aria-label="Next pictures"');
    expect(html).not.toContain('class="blk-gallery"');
  });

  it("has no arrows where every picture shows at once, and lays them out in rows as before unless asked", () => {
    const few = drawn([block("Gallery", { pictures: chosen.slice(0, 2), layout: "row", columns: 3, columnsPhone: 2 })], site);
    expect(few).toContain('<div class="picture-row" style=');
    expect(few).not.toContain("data-arrows");

    const grid = drawn([block("Gallery", { pictures: chosen, columns: 3 })], site);
    expect(grid).toContain('<ul class="blk-gallery" data-gap="normal" style="--cols:3;--cols-phone:2;--ratio:1 / 1">');
    expect(grid).not.toContain("picture-row");
  });
});

describe("a slideshow, as the old website's home page opened", () => {
  const site: SiteContext = { ...EMPTY_SITE, pictures: library(3) };
  const slide = (n: number, more: Record<string, unknown> = {}) => ({
    picture: id(n),
    focus: "center",
    title: `Studio ${n}`,
    text: "",
    buttonLabel: "Book Now",
    buttonLink: `/book?studio=s${n}`,
    ...more,
  });

  it("shows one slide at a time, each picture under its words, with arrows from one to the next", () => {
    const html = drawn([block("Slideshow", { slides: [slide(1, { text: "a romantic space\n\nnow available ", focus: "bottom" }), slide(2), slide(3)] })], site);
    expect(html).toContain('<section class="blk blk-slideshow" data-shade="light">');
    // The sideways row, one slide in view on a computer and on a phone, so the arrows show on both.
    expect(html).toContain('class="picture-row" data-arrows="" data-arrows-phone=""');
    expect(html).toContain('<ul class="picture-row-list slideshow-list" data-gap="none" data-scrolls-sideways="" aria-label="Slideshow">');
    expect(html.match(/<li class="slide"/g)).toHaveLength(3);
    expect(html).toContain('<li class="slide" aria-label="1 of 3">');
    expect(html).toContain('aria-label="Previous slide"');
    expect(html).toContain('aria-label="Next slide"');
    // Its title, each line of its words on its own in italics, and its button to its studio.
    expect(html).toContain("<h2>Studio 1</h2><p><em>a romantic space</em></p><p><em>now available</em></p>");
    expect(html).toContain('href="/book?studio=s1"');
    expect(html).toContain("--focus:bottom");
    // The words come after the picture, so they are drawn over it.
    expect(html.indexOf('class="slide-picture"')).toBeLessThan(html.indexOf("<h2>Studio 1</h2>"));
    // Every picture asked for at once, so the next is there when an arrow moves to it; the first before the others.
    expect(html.match(/<img[^>]*loading="eager"/g)).toHaveLength(3);
    expect(html.match(/<img[^>]*fetchPriority="high"/g)).toHaveLength(1);
  });

  it("leaves out a slide whose picture left the library, and shows visitors nothing without one", () => {
    const html = drawn([block("Slideshow", { slides: [slide(1), slide(9)] })], site);
    expect(html.match(/<li class="slide"/g)).toHaveLength(1);
    // A single slide needs no arrows.
    expect(html).not.toContain("data-arrows");
    expect(drawn([block("Slideshow", { slides: [slide(9)] })], site)).toBe("");
    expect(drawn([block("Slideshow")], site)).toBe("");
  });

  it("can have the title band's dark shade and white words, and a slide without a button", () => {
    const html = drawn([block("Slideshow", { slides: [slide(1, { buttonLabel: "" }), slide(2, { buttonLink: "" })], shade: "dark" })], site);
    expect(html).toContain('data-shade="dark"');
    expect(html).not.toContain("btn");
  });
});

describe("the studios' own pictures", () => {
  let world: TestWorld;
  let catalog: Catalog;
  let site: SiteContext;

  beforeAll(async () => {
    world = await createTestWorld();
    catalog = await loadCatalog(world.db);
    // Blanche with five photos; the others with none, so their tinted boxes stand in.
    const studios = catalog.studios.map((studio) => ({
      ...studio,
      photos: studio.slug === "blanche" ? [1, 2, 3, 4, 5].map((n) => photo(n, `Studio Blanche: photo ${n}`)) : [],
    }));
    site = { ...EMPTY_SITE, catalog: { ...catalog, studios } };
  });
  afterAll(() => world.close());

  it("shows the studios as arches, each name under its picture and leading to the studio, with no button to show it", () => {
    const html = drawn([block("StudioCards", { look: "arches" })], site);
    expect(html).toContain('<ul class="blk studio-arches">');
    expect(html.match(/class="studio-arch"/g)).toHaveLength(catalog.studios.length);
    expect(html).toContain('<a class="studio-arch-link" href="/studios#blanche">');
    expect(html).toContain('alt="Studio Blanche: photo 1"');
    expect(html).toContain('<span class="studio-arch-name">Studio Blanche</span>');
    // A studio without photos keeps its tinted box with its name.
    expect(html).toContain('<span class="studio-arch-img paris-bg"><span class="studio-placeholder-text">Studio Paris</span></span>');
    expect(html).toMatch(/From \$\d+\/hour/);
    expect(html).toContain('href="/book?studio=blanche"');
    expect(html).not.toContain("View Studio");
    // The cards are as they were unless the arches are asked for.
    expect(drawn([block("StudioCards")], site)).toContain('<div class="blk studios-grid">');
  });

  it("shows a studio's other photos large, in a row that scrolls sideways, under its first", () => {
    const html = drawn([block("StudioDetails")], site);
    const blanche = html.slice(html.indexOf('id="blanche"'), html.indexOf('id="dayglow"') > 0 ? html.indexOf('id="dayglow"') : undefined);
    expect(blanche).toContain('class="studio-card-img studio-main-photo blanche-bg"');
    expect(blanche).toContain('<ul class="picture-row-list studio-photo-strip" data-gap="normal" data-scrolls-sideways="" aria-label="More photos of Studio Blanche">');
    const row = blanche.slice(blanche.indexOf("studio-photo-strip"), blanche.indexOf("</ul>", blanche.indexOf("studio-photo-strip")));
    expect(row.match(/<li>/g)).toHaveLength(4);
    expect(blanche).toContain("--cols:3.3;--cols-phone:1.15;--ratio:1 / 1");
    // Four photos are more than three and a part show at once: the arrows show.
    expect(blanche).toContain('data-arrows=""');
    // A studio with no photos has no row.
    const paris = html.slice(html.indexOf('id="paris"'));
    expect(paris).not.toContain("picture-row");
  });
});
