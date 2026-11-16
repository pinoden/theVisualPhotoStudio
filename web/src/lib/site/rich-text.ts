import sanitizeHtml from "sanitize-html";
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

const ALIGN = { "text-align": [/^(left|center|right)$/] };

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ["p", "br", "strong", "em", "u", "a", "ul", "ol", "li", "h2", "h3", "h4", "blockquote"],
  allowedAttributes: {
    a: ["href", "target", "rel"],
    p: ["style"],
    h2: ["style"],
    h3: ["style"],
    h4: ["style"],
  },
  allowedStyles: { p: ALIGN, h2: ALIGN, h3: ALIGN, h4: ALIGN },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowProtocolRelative: false,
  // The text of a tag that is not allowed stays; the text of these does not: it was never meant to be read.
  nonTextTags: ["script", "style", "textarea", "option", "noscript", "template", "iframe", "object", "embed", "svg", "math", "title", "head"],
  transformTags: {
    b: "strong",
    i: "em",
    // A page has one main heading, which is not part of its running text.
    h1: "h2",
    h5: "h4",
    h6: "h4",
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
  return sanitizeHtml(input.slice(0, RICH_TEXT_MAX), OPTIONS)
    .replace(/<br \/>/g, "<br>")
    .replace(/ style="text-align:(left|center|right)"/g, ' style="text-align: $1"')
    .trim();
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
