import sanitizeHtml from "sanitize-html";
import { allHold, markerOf, type Holds } from "./conditions";
import { isInternalHref, parseHref } from "./frame";

/**
 * Formatted text on a page of the website: paragraphs, bold, italic,
 * underline, links, lists, smaller headings, quotes and alignment.
 *
 * The page editor writes such text as HTML. HTML that a browser is given to
 * show can do anything, so it is never stored or shown as it arrives:
 * `sanitizeRichText` keeps the few tags and attributes listed here and drops
 * everything else, on the way into the database and again on the way out.
 * What it returns is the only HTML the site ever writes into a page.
 *
 * Server only: the sanitiser is not sent to browsers.
 */

/** Longer text than any page needs. What is over is cut. */
export const RICH_TEXT_MAX = 30_000;

/**
 * The one style a paragraph or a heading may have: its alignment, written
 * anew from what arrived, so nothing else of a style can come through. The
 * cleaner's own reading of styles is switched off (`parseStyleAttributes`):
 * it goes through a CSS parser that draws random numbers, which Next.js
 * refuses while it prerenders a page.
 */
function aligned(tagName: string): sanitizeHtml.Transformer {
  return (_tagName, attribs): sanitizeHtml.Tag => {
    const align = /(?:^|;)\s*text-align\s*:\s*(left|center|right)\s*(?:;|$)/i.exec(attribs.style ?? "")?.[1];
    return { tagName, attribs: align ? { style: `text-align: ${align.toLowerCase()}` } : {} };
  };
}

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ["p", "br", "strong", "em", "u", "a", "ul", "ol", "li", "h2", "h3", "h4", "blockquote"],
  allowedAttributes: {
    a: ["href", "target", "rel"],
    // Only ever the alignment `aligned` wrote: every tag that keeps a style is one of its transforms below.
    p: ["style"],
    h2: ["style"],
    h3: ["style"],
    h4: ["style"],
  },
  parseStyleAttributes: false,
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowProtocolRelative: false,
  // The text of a tag that is not allowed stays; the text of these does not: it was never meant to be read.
  nonTextTags: ["script", "style", "textarea", "option", "noscript", "template", "iframe", "object", "embed", "svg", "math", "title", "head"],
  transformTags: {
    b: "strong",
    i: "em",
    p: aligned("p"),
    h2: aligned("h2"),
    h3: aligned("h3"),
    h4: aligned("h4"),
    // A page has one main heading, which is not part of its running text.
    h1: aligned("h2"),
    h5: aligned("h4"),
    h6: aligned("h4"),
    a: (_tagName, attribs): sanitizeHtml.Tag => {
      // The same rule as for a link of the menu: a page of this site, a web address, an email or a phone link.
      const href = parseHref(attribs.href);
      if (!href) return { tagName: "span", attribs: {} }; // not a link: its words stay, as plain text
      const leaves: sanitizeHtml.Attributes = isInternalHref(href) ? {} : { target: "_blank", rel: "noopener noreferrer" };
      return { tagName: "a", attribs: { href, ...leaves } };
    },
  },
};

/**
 * The formatted text that is safe to store and to show, from whatever
 * arrived. "" for anything that is not text. Two details are written the way
 * the editor writes them, so that text which was not changed is the same
 * after being saved and read back: a line break, and an alignment.
 */
export function sanitizeRichText(input: unknown): string {
  if (typeof input !== "string") return "";
  return written(sanitizeHtml(input.slice(0, RICH_TEXT_MAX), OPTIONS));
}

/** HTML from the cleaner, with a line break and an alignment written the way the editor writes them. */
const written = (html: string) =>
  html
    .replace(/<br \/>/g, "<br>")
    .replace(/ style="text-align:(left|center|right)"/g, ' style="text-align: $1"')
    .trim();

/** The pieces of formatted text that a marker can make conditional (src/lib/site/conditions.ts). */
const CONDITIONAL = new Set(["p", "li", "h2", "h3", "h4", "blockquote"]);

/** What holds other pieces, and is left out with them when none of them is left. */
const CONTAINERS = new Set(["ul", "ol", "blockquote"]);

/** Markers just inside the opening tag of such a piece, after any other opening tags. */
const LEADING_MARKERS = /(<(?:p|li|h2|h3|h4|blockquote)\b[^>]*>(?:\s*<(?:p|strong|em|u|a|span)\b[^>]*>)*)(\s*(?:\{if (?:not )?[a-z][a-z -]{0,40}[a-z]\}\s*)+)/g;

/**
 * Formatted text as a visitor gets it: cleaned, then without the paragraphs,
 * list items, headings and quotes whose words start with a condition that
 * does not hold now (`{if pets}`), and without the markers of the ones that
 * stay. The text of a piece includes the text of what is inside it, so a
 * list item can start with a bold marker. Server only, like the cleaner.
 */
export function showRichText(input: unknown, holds: Holds | undefined): string {
  const clean = sanitizeRichText(input);
  if (!clean.includes("{if ")) return clean;
  const kept = holds
    ? written(
        sanitizeHtml(clean, {
          // The cleaner once more, which changes nothing in clean text: this pass only leaves pieces out.
          ...OPTIONS,
          exclusiveFilter: (frame) => {
            // The text of a piece is complete when it closes, without the pieces inside it that were left out.
            if (CONTAINERS.has(frame.tag) && frame.text.trim() === "") return true;
            if (!CONDITIONAL.has(frame.tag)) return false;
            const marker = markerOf(frame.text);
            return marker !== null && !allHold(marker.whens, holds);
          },
        }),
      )
    : clean;
  // Markers that name no condition are not markers, and stay as they were typed.
  return kept.replace(LEADING_MARKERS, (whole, open: string, markers: string) => (markerOf(markers) ? open : whole));
}

export { paragraphs } from "./paragraphs";

/** The words of formatted text without their formatting, for a summary or a search. */
export function plainText(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
