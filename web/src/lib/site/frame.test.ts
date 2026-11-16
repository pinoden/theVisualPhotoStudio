import { describe, expect, it } from "vitest";
import {
  announcementShows,
  cleanLine,
  copyrightLine,
  DEFAULT_FRAME,
  FRAME_LIMITS,
  isInternalHref,
  parseFrame,
  parseHref,
  telHref,
  type SiteFrame,
} from "./frame";

/** The owner's requirement 25: the logo, the menu and its dropdowns, the booking button, the footer, social links, contact details and the announcement bar. */

const clone = (frame: SiteFrame): SiteFrame => JSON.parse(JSON.stringify(frame));

describe("the frame the site was built with", () => {
  it("is a valid frame, and reading it changes nothing", () => {
    expect(parseFrame(DEFAULT_FRAME)).toEqual(DEFAULT_FRAME);
    expect(parseFrame(undefined)).toEqual(DEFAULT_FRAME);
    expect(parseFrame([1, 2, 3])).toEqual(DEFAULT_FRAME);
    expect(parseFrame({ business: 4, menu: "x", footer: [], social: {}, announcement: null })).toEqual(DEFAULT_FRAME);
  });

  it("has the menu and the footer the designer made", () => {
    expect(DEFAULT_FRAME.menu.map((item) => item.label)).toEqual(["Our Studios", "Rates", "Info", "Contact", "My Bookings"]);
    expect(DEFAULT_FRAME.menu[2].children.map((link) => link.href)).toEqual(["/faq", "/services", "/policies", "/rates"]);
    expect(DEFAULT_FRAME.footer.columns.map((column) => column.title)).toEqual(["Studios", "Info"]);
    expect(copyrightLine(DEFAULT_FRAME)).toBe("© The Visuals Photo Studio. All rights reserved.");
  });
});

describe("a link an owner typed", () => {
  it("is kept when it is a page of this site, a web address, an email link or a phone link", () => {
    for (const good of ["/", "/rates", "/studios#paris", "/book?studio=blanche", "https://instagram.com/thevisuals", "http://example.org/a?b=1", "mailto:hello@example.com", "tel:+14076636109"]) {
      expect(parseHref(good), good).toBe(good);
    }
    expect(parseHref("  /rates  ")).toBe("/rates");
    expect(isInternalHref("/rates")).toBe(true);
    expect(isInternalHref("https://example.org")).toBe(false);
  });

  it("is left out when it is anything else, a script above all", () => {
    const bad = [
      "",
      "rates",
      "//evil.example/steal",
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:x",
      "/a b",
      "/a\\b",
      '/a"onmouseover="x',
      "https://",
      "https://nodots",
      "mailto:not-an-address",
      "tel:call-me",
      `/${"x".repeat(FRAME_LIMITS.href)}`,
      null,
      42,
    ];
    for (const href of bad) expect(parseHref(href), String(href)).toBeNull();
  });
});

describe("reading a frame that was stored or sent", () => {
  it("keeps a complete menu item, and leaves out one that has no name or leads nowhere", () => {
    const frame = parseFrame({
      menu: [
        { label: "  Gift   Cards ", href: "/contact", children: [] },
        { label: "", href: "/rates" },
        { label: "Nowhere", href: "javascript:alert(1)" },
        { label: "More", href: "/ignored", children: [{ label: "Policies", href: "/policies" }, { label: "Bad", href: "nope" }, { label: "", href: "/faq" }] },
        { label: "Empty list", children: [{ label: "", href: "" }] },
        "not an item",
      ],
    });
    expect(frame.menu).toEqual([
      { label: "Gift Cards", href: "/contact", children: [] },
      // An item with a list is a dropdown: its own link is not used.
      { label: "More", href: "", children: [{ label: "Policies", href: "/policies" }] },
    ]);
  });

  it("lets the menu be emptied, and cuts one that is too long", () => {
    expect(parseFrame({ menu: [] }).menu).toEqual([]);
    const many = Array.from({ length: 30 }, (_, index) => ({ label: `Item ${index}`, href: "/rates", children: [] }));
    expect(parseFrame({ menu: many }).menu).toHaveLength(FRAME_LIMITS.menuItems);
    const deep = [{ label: "More", children: many }];
    expect(parseFrame({ menu: deep }).menu[0].children).toHaveLength(FRAME_LIMITS.menuChildren);
  });

  it("never leaves the studio without a name, an address or a phone: emails and receipts print them", () => {
    const frame = parseFrame({ business: { name: "  ", addressLine1: "", addressLine2: null, phone: "", mapsUrl: "javascript:x", note: "" } });
    expect(frame.business).toEqual({ ...DEFAULT_FRAME.business, note: "" });
    const changed = parseFrame({ business: { name: "Studio Nine", addressLine1: "9 Main St", addressLine2: "Orlando, FL 32801", phone: "+44 20 7946 0000", mapsUrl: "https://maps.example/x", note: "Open daily" } });
    expect(changed.business).toEqual({ name: "Studio Nine", addressLine1: "9 Main St", addressLine2: "Orlando, FL 32801", phone: "+44 20 7946 0000", mapsUrl: "https://maps.example/x", note: "Open daily" });
    // A map link has to be a web address: a page of this site is not a map.
    expect(parseFrame({ business: { mapsUrl: "/contact" } }).business.mapsUrl).toBe(DEFAULT_FRAME.business.mapsUrl);
  });

  it("cuts text to its length and makes it one line", () => {
    expect(cleanLine("  The\n\nVisuals\t Photo   Studio \u0000", 80)).toBe("The Visuals Photo Studio");
    expect(cleanLine("abcdefgh", 5)).toBe("abcde");
    expect(cleanLine(12, 5)).toBe("");
    const frame = parseFrame({ logo: { text: "x".repeat(500), accent: "" }, footer: { tagline: "y".repeat(5000) } });
    expect(frame.logo).toEqual({ text: "x".repeat(FRAME_LIMITS.label), accent: "", image: "" });
    expect(frame.footer.tagline).toHaveLength(FRAME_LIMITS.tagline);
  });

  it("keeps a footer column that has a heading and at least one link", () => {
    const frame = parseFrame({
      footer: {
        tagline: "",
        columns: [
          { title: "Visit", links: [{ label: "Rates", href: "/rates" }] },
          { title: "", links: [{ label: "Rates", href: "/rates" }] },
          { title: "Empty", links: [{ label: "", href: "" }] },
        ],
        contactTitle: "",
        copyright: "",
      },
    });
    expect(frame.footer).toEqual({ tagline: "", columns: [{ title: "Visit", links: [{ label: "Rates", href: "/rates" }] }], contactTitle: "Visit Us", copyright: "" });
    expect(copyrightLine(frame)).toBe("© The Visuals Photo Studio.");
    expect(parseFrame({ footer: { columns: Array.from({ length: 9 }, () => ({ title: "T", links: [{ label: "L", href: "/" }] })) } }).footer.columns).toHaveLength(FRAME_LIMITS.footerColumns);
  });

  it("keeps a social link of a known network with a secure address", () => {
    const frame = parseFrame({
      social: [
        { network: "instagram", url: "https://instagram.com/thevisuals" },
        { network: "myspace", url: "https://myspace.com/x" },
        { network: "facebook", url: "http://facebook.com/x" },
        { network: "tiktok", url: "/tiktok" },
        { network: "youtube", url: "javascript:alert(1)" },
      ],
    });
    expect(frame.social).toEqual([{ network: "instagram", url: "https://instagram.com/thevisuals" }]);
  });

  it("keeps the booking button's words and look, and nothing else about it", () => {
    expect(parseFrame({ bookButton: { label: "Reserve", style: "accent", href: "https://evil.example" } }).bookButton).toEqual({ label: "Reserve", style: "accent" });
    expect(parseFrame({ bookButton: { label: "", style: "sparkly" } }).bookButton).toEqual(DEFAULT_FRAME.bookButton);
    expect(parseFrame({ header: { menuPosition: "center" } }).header.menuPosition).toBe("center");
    expect(parseFrame({ header: { menuPosition: "upside-down" } }).header.menuPosition).toBe("right");
  });
});

describe("the announcement bar", () => {
  const withBar = (announcement: Partial<SiteFrame["announcement"]>) => parseFrame({ ...clone(DEFAULT_FRAME), announcement: { enabled: true, text: "Holiday sets are up", ...announcement } });

  it("shows only when it is switched on and has something to say", () => {
    expect(announcementShows(DEFAULT_FRAME, "2026-12-01")).toBe(false);
    expect(announcementShows(withBar({}), "2026-12-01")).toBe(true);
    expect(announcementShows(withBar({ text: "   " }), "2026-12-01")).toBe(false);
    expect(announcementShows(withBar({ enabled: false }), "2026-12-01")).toBe(false);
  });

  it("shows from its first day to its last, on the studio's clock", () => {
    const bar = withBar({ from: "2026-12-01", until: "2026-12-24" });
    expect(announcementShows(bar, "2026-11-30")).toBe(false);
    expect(announcementShows(bar, "2026-12-01")).toBe(true);
    expect(announcementShows(bar, "2026-12-24")).toBe(true);
    expect(announcementShows(bar, "2026-12-25")).toBe(false);
    expect(announcementShows(withBar({ from: "2026-12-01" }), "2030-01-01")).toBe(true);
    expect(announcementShows(withBar({ until: "2026-12-24" }), "2020-01-01")).toBe(true);
  });

  it("drops dates that are not dates, and a last day before the first", () => {
    expect(withBar({ from: "soon", until: "2026-02-30" }).announcement).toMatchObject({ from: "", until: "" });
    expect(withBar({ from: "2026-12-10", until: "2026-12-01" }).announcement).toMatchObject({ from: "2026-12-10", until: "" });
  });

  it("has a link only when the link has both its words and its address", () => {
    expect(withBar({ linkLabel: "Book now", linkHref: "/book" }).announcement).toMatchObject({ linkLabel: "Book now", linkHref: "/book" });
    expect(withBar({ linkLabel: "Book now", linkHref: "javascript:alert(1)" }).announcement).toMatchObject({ linkLabel: "", linkHref: "" });
    expect(withBar({ linkLabel: "", linkHref: "/book" }).announcement).toMatchObject({ linkLabel: "", linkHref: "" });
    expect(withBar({ text: "z".repeat(999) }).announcement.text).toHaveLength(FRAME_LIMITS.announcement);
  });
});

describe("the link that dials the studio", () => {
  it("is worked out from the phone number as it is shown", () => {
    expect(telHref("(407) 663-6109")).toBe("tel:+14076636109");
    expect(telHref("1-407-663-6109")).toBe("tel:+14076636109");
    expect(telHref("+44 20 7946 0000")).toBe("tel:+442079460000");
    expect(telHref("663-6109")).toBe("tel:6636109");
  });
});

describe("a logo that is a picture", () => {
  it("is named by the picture's id, and by nothing else", () => {
    const id = "0F8FAD5B-D9CB-469F-A165-70867728950E";
    expect(parseFrame({ logo: { text: "The Visuals", accent: "", image: id } }).logo).toEqual({ text: "The Visuals", accent: "", image: id.toLowerCase() });
    for (const bad of ["/media/x.png", "https://evil.example/logo.png", "javascript:alert(1)", 7, null, "0f8fad5b"]) {
      expect(parseFrame({ logo: { image: bad } }).logo.image, String(bad)).toBe("");
    }
    expect(DEFAULT_FRAME.logo.image).toBe("");
  });
});
