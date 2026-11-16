/**
 * The frame around every page of the website: the studio's name and contact
 * details, the logo, the menu with its dropdowns, the booking button, the
 * footer, the social links and the announcement bar. The owners set it under
 * Admin, Website, "Header, menu & footer". It is stored as a document (a draft
 * and a published copy, see src/server/website.ts).
 *
 * `parseFrame` turns whatever was stored or sent into a complete, valid
 * frame: text is cut to its length, a link that is not a link is left out, and
 * a list is cut to its limit. The contact details are also what the emails
 * and the PDF receipts print, so they are never empty: an empty one takes the
 * default.
 */

export interface SiteLink {
  label: string;
  href: string;
}

/** An item of the menu. With `children` it opens a dropdown and its own `href` is not used. */
export interface MenuItem extends SiteLink {
  children: SiteLink[];
}

export const SOCIAL_NETWORKS = {
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  pinterest: "Pinterest",
  youtube: "YouTube",
  x: "X",
  linkedin: "LinkedIn",
} as const;
export type SocialNetwork = keyof typeof SOCIAL_NETWORKS;

export const BOOK_BUTTON_STYLES = { dark: "Dark", accent: "Accent colour", outline: "Outline" } as const;
export type BookButtonStyle = keyof typeof BOOK_BUTTON_STYLES;

export const ANNOUNCEMENT_STYLES = { accent: "Accent colour", dark: "Dark" } as const;
export type AnnouncementStyle = keyof typeof ANNOUNCEMENT_STYLES;

export const MENU_POSITIONS = { right: "On the right", center: "In the middle" } as const;
export type MenuPosition = keyof typeof MENU_POSITIONS;

export interface SiteFrame {
  business: {
    name: string;
    addressLine1: string;
    addressLine2: string;
    /** As it is shown: "(407) 663-6109". The link that dials it is worked out (`telHref`). */
    phone: string;
    mapsUrl: string;
    /** A short line under the contact details: "By appointment only". May be empty. */
    note: string;
  };
  /**
   * What search engines and browser tabs show for the site as a whole: the
   * title of the home page, and the description of any page that has none of
   * its own. Every other page's title is its own name, then the studio's.
   */
  search: { title: string; description: string };
  /**
   * The logo is two pieces of text; the second is in the accent colour. With
   * `image` (the id of a picture of the media library) the header shows that
   * picture and the text is what is read out for it.
   */
  logo: { text: string; accent: string; image: string };
  header: { menuPosition: MenuPosition };
  menu: MenuItem[];
  /** The button at the end of the menu. It always leads to the booking page: only its words and look change. */
  bookButton: { label: string; style: BookButtonStyle };
  footer: {
    tagline: string;
    columns: { title: string; links: SiteLink[] }[];
    /** The heading above the address and phone. */
    contactTitle: string;
    /** After "© <the studio's name>.": "All rights reserved." */
    copyright: string;
  };
  social: { network: SocialNetwork; url: string }[];
  announcement: {
    enabled: boolean;
    text: string;
    /** Optional: a link after the text. Both or neither. */
    linkLabel: string;
    linkHref: string;
    /** Optional first and last day it shows, on the studio's clock: "2026-12-01", or "" for no limit. */
    from: string;
    until: string;
    style: AnnouncementStyle;
  };
}

/** The studio's name and contact details: on the website, in every email and on every receipt. */
export type Business = SiteFrame["business"];

/** Whether a link leads to the page at `path`: "/faq", "/faq#pets" and "/faq?from=menu" all lead to "/faq". */
export function leadsTo(href: string, path: string): boolean {
  return href === path || href.startsWith(`${path}#`) || href.startsWith(`${path}?`);
}

/**
 * Where the header, the menu and the footer link to the page at `path`, in
 * words: "the menu (Info, Guest Information)". For a warning before a page
 * leaves the website. A menu item with a dropdown has no link of its own.
 */
export function frameLinksTo(frame: SiteFrame, path: string): string[] {
  const found: string[] = [];
  for (const item of frame.menu) {
    if (item.children.length === 0 && leadsTo(item.href, path)) found.push(`the menu (${item.label})`);
    for (const child of item.children) if (leadsTo(child.href, path)) found.push(`the menu (${item.label}, ${child.label})`);
  }
  for (const column of frame.footer.columns) {
    for (const link of column.links) if (leadsTo(link.href, path)) found.push(`the footer (${link.label})`);
  }
  if (frame.announcement.linkHref !== "" && leadsTo(frame.announcement.linkHref, path)) found.push("the announcement bar");
  return found;
}

export const FRAME_LIMITS = {
  menuItems: 8,
  menuChildren: 8,
  footerColumns: 4,
  footerLinks: 10,
  social: 7,
  label: 40,
  line: 120,
  tagline: 300,
  searchTitle: 70,
  searchDescription: 200,
  announcement: 240,
  href: 300,
} as const;

/** The page the booking button leads to. Fixed, so that no edit of the menu can break booking. */
export const BOOK_PATH = "/book";

export const DEFAULT_FRAME: SiteFrame = {
  business: {
    name: "The Visuals Photo Studio",
    addressLine1: "7457 Aloma Ave, Suite 301",
    addressLine2: "Winter Park, FL 32792",
    phone: "(407) 663-6109",
    mapsUrl: "https://maps.google.com/?q=7457+Aloma+Ave+Winter+Park+FL",
    note: "By appointment only",
  },
  search: {
    title: "The Visuals Photo Studio | Winter Park, FL",
    description:
      "Natural-light photography studios for rent in Winter Park, FL. Studio Blanche, Dayglow and Paris, bookable by the hour.",
  },
  logo: { text: "The Visuals", accent: "Photo Studio", image: "" },
  header: { menuPosition: "right" },
  menu: [
    { label: "Our Studios", href: "/studios", children: [] },
    { label: "Rates", href: "/rates", children: [] },
    {
      label: "Info",
      href: "",
      children: [
        { label: "Guest Information", href: "/faq" },
        { label: "Photography", href: "/services" },
        { label: "Policies", href: "/policies" },
        { label: "Rates", href: "/rates" },
      ],
    },
    { label: "Contact", href: "/contact", children: [] },
    { label: "My Bookings", href: "/account", children: [] },
  ],
  bookButton: { label: "Book Now", style: "dark" },
  footer: {
    tagline:
      "Natural-light photography studios in Winter Park, FL. Designed for photographers, content creators, brands and families.",
    columns: [
      {
        title: "Studios",
        links: [
          { label: "Studio Blanche", href: "/studios#blanche" },
          { label: "Studio Dayglow", href: "/studios#dayglow" },
          { label: "Studio Paris", href: "/studios#paris" },
        ],
      },
      {
        title: "Info",
        links: [
          { label: "Rates", href: "/rates" },
          { label: "Photography", href: "/services" },
          { label: "Guest Information", href: "/faq" },
          { label: "Policies", href: "/policies" },
          { label: "Contact", href: "/contact" },
          { label: "Book a studio", href: "/book" },
        ],
      },
    ],
    contactTitle: "Visit Us",
    copyright: "All rights reserved.",
  },
  social: [],
  announcement: { enabled: false, text: "", linkLabel: "", linkHref: "", from: "", until: "", style: "accent" },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One line of text: line breaks and runs of spaces become one space, and it is cut to `max` characters. */
export function cleanLine(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

/**
 * A link an owner typed, when it is one the site will show: a page of this
 * site ("/rates", "/studios#paris"), a web address that starts with https://
 * or http://, an email link (mailto:) or a phone link (tel:). Null otherwise,
 * so that nothing else (a script, above all) can become a link.
 */
export function parseHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const href = value.trim();
  if (href === "" || href.length > FRAME_LIMITS.href || /[\s\u0000-\u001f\u007f<>"'`\\]/.test(href)) return null;
  if (href.startsWith("/")) return href.startsWith("//") ? null : href;
  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      return url.hostname.includes(".") || url.hostname === "localhost" ? href : null;
    } catch {
      return null;
    }
  }
  if (/^mailto:[^@\s]+@[^@\s]+\.[^@\s]+$/i.test(href)) return href;
  if (/^tel:\+?[0-9()\-.]{5,20}$/i.test(href)) return href;
  return null;
}

/** True for a page of this site, which the router can open without loading a new document. */
export function isInternalHref(href: string): boolean {
  return href.startsWith("/");
}

function parseLink(value: unknown): SiteLink | null {
  if (!isRecord(value)) return null;
  const label = cleanLine(value.label, FRAME_LIMITS.label);
  const href = parseHref(value.href);
  return label && href ? { label, href } : null;
}

function parseLinks(value: unknown, max: number): SiteLink[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(parseLink)
    .filter((link): link is SiteLink => link !== null)
    .slice(0, max);
}

function parseMenu(value: unknown): MenuItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: MenuItem[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const label = cleanLine(raw.label, FRAME_LIMITS.label);
    if (!label) continue;
    const children = parseLinks(raw.children, FRAME_LIMITS.menuChildren);
    const href = parseHref(raw.href);
    // An item is either a link or a dropdown. One that is neither would be a word that does nothing.
    if (children.length === 0 && !href) continue;
    items.push({ label, href: children.length > 0 ? "" : href!, children });
    if (items.length === FRAME_LIMITS.menuItems) break;
  }
  return items;
}

function parseDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? "" : value;
}

const oneOf = <T extends string>(value: unknown, choices: Record<T, string>, fallback: T): T =>
  typeof value === "string" && value in choices ? (value as T) : fallback;

/** A complete, valid frame from whatever was stored or sent. See the note at the top of this file. */
export function parseFrame(input: unknown): SiteFrame {
  const raw = isRecord(input) ? input : {};
  const d = DEFAULT_FRAME;
  const business = isRecord(raw.business) ? raw.business : {};
  const search = isRecord(raw.search) ? raw.search : {};
  const logo = isRecord(raw.logo) ? raw.logo : {};
  const header = isRecord(raw.header) ? raw.header : {};
  const bookButton = isRecord(raw.bookButton) ? raw.bookButton : {};
  const footer = isRecord(raw.footer) ? raw.footer : {};
  const announcement = isRecord(raw.announcement) ? raw.announcement : {};
  const line = (value: unknown, max: number, fallback: string) => cleanLine(value, max) || fallback;
  /** Text that may be left empty on purpose: the default only when nothing was stored at all. */
  const optional = (value: unknown, max: number, fallback: string) => (typeof value === "string" ? cleanLine(value, max) : fallback);

  const mapsUrl = parseHref(business.mapsUrl);
  const linkLabel = cleanLine(announcement.linkLabel, FRAME_LIMITS.label);
  const linkHref = parseHref(announcement.linkHref);
  const from = parseDate(announcement.from);
  const until = parseDate(announcement.until);

  return {
    business: {
      name: line(business.name, 80, d.business.name),
      addressLine1: line(business.addressLine1, FRAME_LIMITS.line, d.business.addressLine1),
      addressLine2: line(business.addressLine2, FRAME_LIMITS.line, d.business.addressLine2),
      phone: line(business.phone, 30, d.business.phone),
      mapsUrl: mapsUrl && /^https?:/i.test(mapsUrl) ? mapsUrl : d.business.mapsUrl,
      note: optional(business.note, FRAME_LIMITS.line, d.business.note),
    },
    search: {
      title: line(search.title, FRAME_LIMITS.searchTitle, d.search.title),
      description: line(search.description, FRAME_LIMITS.searchDescription, d.search.description),
    },
    logo: {
      text: line(logo.text, FRAME_LIMITS.label, d.logo.text),
      accent: optional(logo.accent, FRAME_LIMITS.label, d.logo.accent),
      image: typeof logo.image === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(logo.image) ? logo.image.toLowerCase() : "",
    },
    header: { menuPosition: oneOf(header.menuPosition, MENU_POSITIONS, d.header.menuPosition) },
    menu: parseMenu(raw.menu) ?? d.menu,
    bookButton: {
      label: line(bookButton.label, 24, d.bookButton.label),
      style: oneOf(bookButton.style, BOOK_BUTTON_STYLES, d.bookButton.style),
    },
    footer: {
      tagline: optional(footer.tagline, FRAME_LIMITS.tagline, d.footer.tagline),
      columns: Array.isArray(footer.columns)
        ? footer.columns
            .filter(isRecord)
            .map((column) => ({
              title: cleanLine(column.title, FRAME_LIMITS.label),
              links: parseLinks(column.links, FRAME_LIMITS.footerLinks),
            }))
            .filter((column) => column.title !== "" && column.links.length > 0)
            .slice(0, FRAME_LIMITS.footerColumns)
        : d.footer.columns,
      contactTitle: line(footer.contactTitle, FRAME_LIMITS.label, d.footer.contactTitle),
      copyright: optional(footer.copyright, FRAME_LIMITS.line, d.footer.copyright),
    },
    social: Array.isArray(raw.social)
      ? raw.social
          .filter(isRecord)
          .map((entry) => ({ network: entry.network, url: parseHref(entry.url) }))
          .filter(
            (entry): entry is { network: SocialNetwork; url: string } =>
              typeof entry.network === "string" && entry.network in SOCIAL_NETWORKS && entry.url !== null && /^https:\/\//i.test(entry.url),
          )
          .slice(0, FRAME_LIMITS.social)
      : d.social,
    announcement: {
      enabled: announcement.enabled === true,
      text: cleanLine(announcement.text, FRAME_LIMITS.announcement),
      linkLabel: linkLabel && linkHref ? linkLabel : "",
      linkHref: linkLabel && linkHref ? linkHref : "",
      from,
      // A last day before the first day would never show: the last day is dropped, the first kept.
      until: from && until && until < from ? "" : until,
      style: oneOf(announcement.style, ANNOUNCEMENT_STYLES, d.announcement.style),
    },
  };
}

/** The link that dials the studio's phone number: "(407) 663-6109" -> "tel:+14076636109". */
export function telHref(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (phone.trim().startsWith("+")) return `tel:+${digits}`;
  if (digits.length === 10) return `tel:+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `tel:+${digits}`;
  return `tel:${digits}`;
}

/** Whether the announcement shows on `today` (a date on the studio's clock, "2026-12-01"). */
export function announcementShows(frame: SiteFrame, today: string): boolean {
  const { enabled, text, from, until } = frame.announcement;
  return enabled && text !== "" && (from === "" || today >= from) && (until === "" || today <= until);
}

/** The line at the very bottom of every page. */
export function copyrightLine(frame: SiteFrame): string {
  return `© ${frame.business.name}.${frame.footer.copyright ? ` ${frame.footer.copyright}` : ""}`;
}
