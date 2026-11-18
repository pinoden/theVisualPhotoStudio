// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { parsePage } from "@/lib/site/page";
import { BLOCK_NAMES } from "@/lib/site/blocks/registry";

// The picture chooser asks the server for the library: not needed to build the editor's settings.
vi.mock("@/app/admin/website/media/actions", () => ({ choosablePicturesAction: async () => [] }));
// The drag-and-drop library notices changes of size as soon as it loads; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
const { buildPuckConfig, fromPuckData, toPuckData } = await import("./puck-config");

/** The page editor's settings and its data, which must say exactly what the site stores. */
const PICTURE = "0f8fad5b-d9cb-469f-a165-70867728950e";
const page = parsePage({
  meta: { title: "Gift cards", description: "Give a session.", hidden: true },
  blocks: [
    {
      type: "Section",
      props: {
        space: "large",
        spacePhone: "small",
        content: [
          { type: "Heading", props: { text: "Gift cards", level: "h1", alignPhone: "start" } },
          { type: "Spacer", props: { height: 64, heightPhone: 24 } },
          { type: "Spacer", props: { height: 32 } },
          { type: "Cards", props: { columns: 2, cards: [{ title: "One", text: "First" }] } },
          { type: "Picture", props: { picture: PICTURE, caption: true } },
          { type: "Questions", props: { questions: [{ question: "Why?", answer: "<p>Because.</p>" }] } },
        ],
      },
    },
  ],
});

describe("the page editor's data", () => {
  it("is what the site stores, turned for the editor and back without a change", () => {
    expect(fromPuckData(toPuckData(page))).toEqual(page);
  });

  it("keeps the page's settings for search engines as the root's values", () => {
    expect(toPuckData(page).root).toEqual({ props: { title: "Gift cards", description: "Give a session.", hidden: true } });
  });

  it("shows a number for phones that is as on a computer as an empty choice, and reads it back as none", () => {
    const content = toPuckData(page).content as unknown as { props: { content: { type: string; props: Record<string, unknown> }[] } }[];
    const [first, second] = content[0].props.content.filter((block) => block.type === "Spacer");
    expect(first.props.heightPhone).toBe(24);
    expect(second.props.heightPhone).toBe("");
    // What a form gives back as text is read as the number it is.
    const edited = toPuckData(page);
    const spacer = (edited.content as unknown as { props: { content: { type: string; props: Record<string, unknown> }[] } }[])[0].props.content[2];
    spacer.props.height = "40";
    spacer.props.heightPhone = "16";
    const back = fromPuckData(edited).blocks[0].props.content as { props: Record<string, unknown> }[];
    expect(back[2].props.height).toBe(40);
    expect(back[2].props.heightPhone).toBe(16);
  });
});

describe("the page editor's settings", () => {
  const config = buildPuckConfig({ collections: [{ id: PICTURE, name: "Christmas" }], links: [{ path: "/gift-cards", title: "Gift cards" }] });
  const fields = (name: string) => (config.components[name] as unknown as { fields: Record<string, { type: string; [key: string]: unknown }> }).fields;

  it("offer every block, sorted into the editor's groups", () => {
    expect(Object.keys(config.components).sort()).toEqual([...BLOCK_NAMES].sort());
    const grouped = Object.values(config.categories ?? {}).flatMap((category) => (category as { components: string[] }).components);
    expect(grouped.sort()).toEqual([...BLOCK_NAMES].sort());
  });

  it("give each field of a block the form field that suits it", () => {
    expect(fields("Heading").text).toMatchObject({ type: "text", contentEditable: true });
    expect(fields("Heading").level.type).toBe("select");
    expect(fields("Heading").line).toMatchObject({ type: "radio", options: [{ label: "Yes", value: true }, { label: "No", value: false }] });
    expect(fields("Heading").alignPhone).toMatchObject({ type: "select", label: "Where it sits, on a phone" });
    expect((fields("Heading").alignPhone.options as { value: unknown }[])[0]).toEqual({ label: "As on a computer", value: "" });
    expect(fields("Text").text).toMatchObject({ type: "richtext", contentEditable: true });
    expect(fields("Section").content).toEqual({ type: "slot" });
    expect(fields("Spacer").height).toMatchObject({ type: "number", min: 8, max: 240, step: 8 });
    expect((fields("Spacer").heightPhone.options as unknown[]).length).toBe(31);
    expect(fields("Picture").picture.type).toBe("custom");
    expect(fields("Gallery").collection.options).toEqual([
      { label: "Choose a collection", value: "" },
      { label: "Christmas", value: PICTURE },
    ]);
    // Inside a list, formatted text is typed in the panel, not on the page.
    const answer = (fields("Questions").questions as unknown as { arrayFields: Record<string, { type: string; contentEditable?: boolean }> }).arrayFields.answer;
    expect(answer).toMatchObject({ type: "richtext", contentEditable: false });
  });

  it("let formatted text hold only what the site keeps", () => {
    const options = (fields("Text").text as unknown as { options: Record<string, unknown> }).options;
    expect(options).toMatchObject({ code: false, codeBlock: false, strike: false, horizontalRule: false, heading: { levels: [2, 3, 4] } });
  });
});
