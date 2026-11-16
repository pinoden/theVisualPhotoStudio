import { describe, expect, it } from "vitest";
import { DEFAULT_FRAME, frameLinksTo, leadsTo, type SiteFrame } from "./frame";
import { pageLinksTo, parsePage } from "./page";

/** Requirement 22's warning before a page leaves the website: what still links to it. */
describe("what links to a page", () => {
  it("is a link to its address, or to a place on it", () => {
    for (const href of ["/faq", "/faq#pets", "/faq?from=menu"]) expect(leadsTo(href, "/faq"), href).toBe(true);
    for (const href of ["/faqs", "/faq-2", "/faq/more", "https://example.org/faq", "", "/"]) expect(leadsTo(href, "/faq"), href).toBe(false);
  });

  it("is found in the menu, its dropdowns, the footer and the announcement", () => {
    expect(frameLinksTo(DEFAULT_FRAME, "/faq")).toEqual(["the menu (Info, Guest Information)", "the footer (Guest Information)"]);
    expect(frameLinksTo(DEFAULT_FRAME, "/rates")).toEqual(["the menu (Rates)", "the menu (Info, Rates)", "the footer (Rates)"]);
    expect(frameLinksTo(DEFAULT_FRAME, "/studios")).toEqual([
      "the menu (Our Studios)",
      "the footer (Studio Blanche)",
      "the footer (Studio Dayglow)",
      "the footer (Studio Paris)",
    ]);
    expect(frameLinksTo(DEFAULT_FRAME, "/gift-cards")).toEqual([]);
    const announced: SiteFrame = { ...DEFAULT_FRAME, announcement: { ...DEFAULT_FRAME.announcement, linkLabel: "See", linkHref: "/gift-cards" } };
    expect(frameLinksTo(announced, "/gift-cards")).toEqual(["the announcement bar"]);
    // A menu item with a dropdown has no link of its own.
    const dropdown: SiteFrame = { ...DEFAULT_FRAME, menu: [{ label: "More", href: "/gift-cards", children: [{ label: "FAQ", href: "/faq" }] }] };
    expect(frameLinksTo(dropdown, "/gift-cards")).toEqual([]);
  });

  it("is found in a page's buttons, cards, formatted text, and blocks inside other blocks", () => {
    const page = (blocks: unknown[]) => parsePage({ blocks });
    const buttons = page([{ type: "Section", props: { content: [{ type: "Buttons", props: { buttons: [{ label: "Questions", link: "/faq#pets", look: "dark" }] } }] } }]);
    expect(pageLinksTo(buttons, "/faq")).toBe(true);
    expect(pageLinksTo(buttons, "/rates")).toBe(false);
    const text = page([{ type: "Text", props: { text: '<p>See <a href="/policies">the policies</a>.</p>' } }]);
    expect(pageLinksTo(text, "/policies")).toBe(true);
    expect(pageLinksTo(text, "/faq")).toBe(false);
    const banner = page([{ type: "Banner", props: { title: "Hi", buttons: [{ label: "Rates", link: "/rates", look: "dark" }] } }]);
    expect(pageLinksTo(banner, "/rates")).toBe(true);
    expect(pageLinksTo(page([]), "/rates")).toBe(false);
  });
});
