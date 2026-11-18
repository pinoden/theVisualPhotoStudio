import { describe, expect, it } from "vitest";
import { cleanText, parseProps } from "./blocks/check";
import { startProps, type Fields } from "./blocks/fields";
import { BLOCK_NAMES, BLOCKS, blockSpec } from "./blocks/registry";
import { eachBlock, EMPTY_PAGE, PAGE_LIMITS, pageReferences, parseBlocks, parsePage, parseSlug, RESERVED_SEGMENTS, slugFromTitle } from "./page";
import { parseVideo } from "./video";

/**
 * The owner's requirements 22 and 23: pages made of blocks. These tests are
 * about what a page is allowed to hold, whatever the editor or anyone else
 * sends.
 */

const PICTURE = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const noSlots = () => [];

describe("the fields of a block", () => {
  const fields = {
    title: { kind: "text", label: "Title", max: 10, start: "Hello" },
    notes: { kind: "text", label: "Notes", max: 40, start: "", lines: true },
    body: { kind: "rich", label: "Body", start: "<p>Start</p>" },
    look: { kind: "choice", label: "Look", options: { plain: "Plain", boxed: "Boxed" }, start: "plain", phone: true },
    on: { kind: "toggle", label: "On", start: true },
    size: { kind: "number", label: "Size", min: 8, max: 64, step: 8, start: 16, phone: true },
    to: { kind: "link", label: "To", start: "/book" },
    picture: { kind: "picture", label: "Picture" },
    pictures: { kind: "pictures", label: "Pictures", max: 2 },
    set: { kind: "collection", label: "Set" },
    items: { kind: "list", label: "Items", max: 2, title: "name", of: { name: { kind: "text", label: "Name", max: 5, start: "Item" } }, start: [{}] },
  } as const satisfies Fields;

  it("start a new block with their starting values, and no value of their own for phones", () => {
    expect(startProps(fields)).toEqual({
      title: "Hello",
      notes: "",
      body: "<p>Start</p>",
      look: "plain",
      lookPhone: "",
      on: true,
      size: 16,
      sizePhone: null,
      to: "/book",
      picture: "",
      pictures: [],
      set: "",
      items: [{ name: "Item" }],
    });
  });

  it("keep valid values as they are", () => {
    const values = {
      title: "Decor",
      notes: "One\nTwo",
      body: "<p>A <strong>b</strong></p>",
      look: "boxed",
      lookPhone: "plain",
      on: false,
      size: 32,
      sizePhone: 8,
      to: "https://example.org/x",
      picture: PICTURE,
      pictures: [PICTURE, OTHER],
      set: OTHER,
      items: [{ name: "One" }, { name: "Two" }],
    };
    expect(parseProps(fields, values, noSlots)).toEqual({ ...values, to: "https://example.org/x" });
  });

  it("put right whatever is not valid, and drop what is not theirs", () => {
    const parsed = parseProps(
      fields,
      {
        title: "  Much   too long\na title ",
        notes: "One  \r\n\r\n\r\n\r\n Two\u0000",
        body: '<p onclick="x()">Hi<script>alert(1)</script></p>',
        look: "sparkly",
        lookPhone: "sparkly",
        on: "yes",
        size: 1000,
        sizePhone: "big",
        to: "javascript:alert(1)",
        picture: "/media/x.jpg",
        pictures: [PICTURE, "junk", PICTURE.toUpperCase(), OTHER, "00000000-0000-4000-8000-000000000000"],
        set: 7,
        items: [{ name: "A long name" }, "junk", { name: 3 }, { name: "Third" }],
        extra: "<script>",
        id: "kept-elsewhere",
      },
      noSlots,
    );
    expect(parsed).toEqual({
      title: "Much too l",
      notes: "One\n\nTwo",
      body: "<p>Hi</p>",
      look: "plain",
      lookPhone: "",
      on: true,
      size: 64,
      sizePhone: null,
      to: "",
      picture: "",
      pictures: [PICTURE, OTHER],
      set: "",
      items: [{ name: "A lon" }, { name: "Item" }],
    });
  });

  it("give every field a value when nothing usable arrives", () => {
    for (const nothing of [undefined, null, "text", 7, []]) {
      expect(parseProps(fields, nothing, noSlots)).toEqual({ ...startProps(fields), picture: "", pictures: [], set: "", to: "" });
    }
  });

  it("tidy text of several lines without joining its lines", () => {
    expect(cleanText(" a  b \n\n\n\n c\t d ", 100, true)).toBe("a b\n\nc d");
    expect(cleanText(" a  b \n c ", 100)).toBe("a b c");
    expect(cleanText(42, 100)).toBe("");
  });
});

describe("the blocks", () => {
  it("each start valid: a new block is unchanged by the check", () => {
    for (const name of BLOCK_NAMES) {
      const start = startProps(BLOCKS[name].fields);
      expect(parseProps(BLOCKS[name].fields, start, (items) => parseBlocks(items)), name).toEqual(start);
    }
  });

  it("are found by the name a page stores, and by no other", () => {
    expect(blockSpec("Heading")?.label).toBe("Heading");
    for (const name of ["heading", "constructor", "toString", "__proto__", "", null, 7]) expect(blockSpec(name), String(name)).toBeUndefined();
  });
});

describe("a page as it is stored", () => {
  const page = {
    meta: { title: "  Our  decor ", description: "x".repeat(500), hidden: "yes" },
    blocks: [
      {
        type: "Section",
        props: {
          id: "Section-a",
          background: "dark",
          content: [
            { type: "Heading", props: { id: "Heading-a", text: "Our decor", level: "h1" } },
            { type: "Picture", props: { id: "Picture-a", picture: PICTURE } },
            { type: "Unknown", props: { id: "x" } },
            { type: "Gallery", props: { id: "Heading-a", source: "collection", collection: OTHER, pictures: [PICTURE] } },
          ],
        },
      },
      { type: "Script", props: { src: "https://evil.example/x.js" } },
      "junk",
      { type: "Text", props: { text: '<p>Hello <a href="javascript:alert(1)">there</a></p>' } },
    ],
    root: { props: { title: "ignored" } },
    zones: { "x:y": [{ type: "Heading", props: {} }] },
  };

  it("keeps the blocks it knows, each checked, and drops the rest", () => {
    const parsed = parsePage(page);
    expect(parsed.meta).toEqual({ title: "Our decor", description: "x".repeat(PAGE_LIMITS.metaDescription), hidden: false });
    expect(parsed.blocks.map((block) => block.type)).toEqual(["Section", "Text"]);
    const section = parsed.blocks[0].props as unknown as { background: string; width: string; content: { type: string; props: Record<string, unknown> }[] };
    expect(section.background).toBe("dark");
    expect(section.width).toBe("wide");
    expect(section.content.map((block) => block.type)).toEqual(["Heading", "Picture", "Gallery"]);
    expect(parsed.blocks[1].props.text).toBe("<p>Hello there</p>");
    expect(Object.keys(parsed)).toEqual(["meta", "blocks"]);
  });

  it("gives every block an id of its own, the same each time", () => {
    const ids: string[] = [];
    eachBlock(parsePage(page).blocks, (block) => ids.push(block.props.id));
    expect(ids).toEqual(["Section-a", "Heading-a", "Picture-a", "Gallery-0-3", "Text-3"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(parsePage(parsePage(page))).toEqual(parsePage(page));
  });

  it("knows which pictures and collections a page names, wherever in it", () => {
    expect(pageReferences(parsePage(page))).toEqual({ pictures: [PICTURE], collections: [OTHER] });
    expect(pageReferences(EMPTY_PAGE)).toEqual({ pictures: [], collections: [] });
  });

  it("is an empty page when nothing usable arrives", () => {
    for (const nothing of [undefined, null, "x", 7, [], { blocks: "x" }]) expect(parsePage(nothing)).toEqual(EMPTY_PAGE);
  });

  it("holds only so many blocks, and only so deep", () => {
    const many = Array.from({ length: PAGE_LIMITS.blocks + 50 }, () => ({ type: "Spacer", props: {} }));
    expect(parsePage({ blocks: many }).blocks).toHaveLength(PAGE_LIMITS.blocks);
    let nested: unknown = [{ type: "Spacer", props: {} }];
    for (let level = 0; level < PAGE_LIMITS.depth + 5; level++) nested = [{ type: "Section", props: { content: nested } }];
    let depth = 0;
    eachBlock(parsePage({ blocks: nested }).blocks, (block) => {
      if (block.type === "Section") depth++;
      expect(block.type).not.toBe("Spacer"); // too deep to be kept
    });
    expect(depth).toBe(PAGE_LIMITS.depth + 1);
  });

  it("lets a place for blocks take only the blocks it allows", () => {
    expect(parseBlocks([{ type: "Heading", props: {} }, { type: "Spacer", props: {} }], ["Spacer"]).map((block) => block.type)).toEqual(["Spacer"]);
  });
});

describe("the address of a page", () => {
  it("is small letters, digits and hyphens, in up to three parts", () => {
    expect(parseSlug("gift-cards")).toEqual({ ok: true, slug: "gift-cards" });
    expect(parseSlug("  /Decor/Winter-2026/ ")).toEqual({ ok: true, slug: "decor/winter-2026" });
    expect(parseSlug("a/b/c")).toEqual({ ok: true, slug: "a/b/c" });
    for (const bad of ["", "/", "a/b/c/d", "gift cards", "gift_cards", "été", "a//b", "-a", "a-", "a--b", "a/../b", "a?b=1", "x".repeat(41), 7, null]) {
      expect(parseSlug(bad).ok, String(bad)).toBe(false);
    }
  });

  it("cannot start with a part the site uses itself", () => {
    for (const taken of ["admin", "book", "account", "api", "media", "staff", "booking", "pay", "book/decor", "ADMIN/x"]) {
      const result = parseSlug(taken);
      expect(result.ok, taken).toBe(false);
      expect(!result.ok && result.message).toContain("the site uses that itself");
    }
    // Only the first part: "decor/admin" is a page like any other.
    expect(parseSlug("decor/admin").ok).toBe(true);
    // The public pages that were written in the code are pages now (2026-11-16): their addresses are ordinary ones.
    for (const free of ["rates", "studios/decor", "faq", "policies", "contact", "services"]) expect(parseSlug(free).ok, free).toBe(true);
    expect(RESERVED_SEGMENTS).toContain("font-files");
  });

  it("can be made from a page's name", () => {
    expect(slugFromTitle("Gift Cards & More!")).toBe("gift-cards-more");
    expect(slugFromTitle("Été à Paris")).toBe("ete-a-paris");
    expect(slugFromTitle("???")).toBe("page");
    expect(slugFromTitle("Admin")).toBe("admin-page");
    expect(parseSlug(slugFromTitle("x".repeat(200))).ok).toBe(true);
    for (const title of ["Gift Cards", "Book", "Rates", "?", "A"]) expect(parseSlug(slugFromTitle(title)).ok, title).toBe(true);
  });
});

describe("a video", () => {
  it("is played by YouTube or Vimeo, from any of the addresses they give out", () => {
    for (const address of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ?t=10",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=x",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
    ]) {
      expect(parseVideo(address), address).toEqual({ service: "youtube", id: "dQw4w9WgXcQ", player: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0" });
    }
    expect(parseVideo("https://vimeo.com/76979871")).toEqual({ service: "vimeo", id: "76979871", player: "https://player.vimeo.com/video/76979871?autoplay=1&dnt=1" });
    expect(parseVideo("https://player.vimeo.com/video/76979871?h=abc")?.id).toBe("76979871");
  });

  it("is nothing from anywhere else, and nothing that could be a script", () => {
    for (const address of [
      "",
      "dQw4w9WgXcQ",
      "https://evil.example/watch?v=dQw4w9WgXcQ",
      "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
      "javascript:alert(1)",
      "https://www.youtube.com/watch?v=<script>",
      'https://www.youtube.com/embed/x"onload="alert(1)',
      "https://vimeo.com/channels/staffpicks",
      "ftp://youtu.be/dQw4w9WgXcQ",
      null,
      7,
    ]) {
      expect(parseVideo(address), String(address)).toBeNull();
    }
  });
});
