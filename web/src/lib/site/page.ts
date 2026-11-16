import { blockSpec } from "./blocks/registry";
import { parseProps, referencedIds } from "./blocks/check";
import type { StoredBlock } from "./blocks/fields";
import { cleanLine } from "./frame";

/**
 * A page of the website as it is stored: what search engines are told about
 * it, and the blocks it is made of, in order.
 *
 * `parsePage` turns whatever was stored or sent into a valid page. A block
 * the site does not know is dropped; every value of a block it does know is
 * checked by the block's own description (blocks/fields.ts). So a page that
 * comes out of here can be drawn as it is, and nothing but a page can come
 * out.
 */

export interface PageMeta {
  /** The page's title in a search result and on the browser's tab. Empty: the page's name is used. */
  title: string;
  /** One or two sentences a search engine may show under the title. Empty: the website's description is used. */
  description: string;
  /** True to ask search engines not to list the page. Its address still works. */
  hidden: boolean;
}

export interface PageContent {
  meta: PageMeta;
  blocks: StoredBlock[];
}

export const PAGE_LIMITS = {
  /** Blocks on one page, the ones inside other blocks included. More than any page needs; it bounds what a request can make the server check. */
  blocks: 400,
  /** How deep blocks can sit inside blocks. */
  depth: 6,
  title: 80,
  metaTitle: 70,
  metaDescription: 200,
  slug: 100,
  segment: 40,
} as const;

export const EMPTY_PAGE: PageContent = { meta: { title: "", description: "", hidden: false }, blocks: [] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The valid blocks among `items`. Every block gets an id of its own: the one
 * it came with when that is usable and not taken, otherwise one made from
 * where the block sits, so that the same page always gets the same ids.
 */
export function parseBlocks(items: unknown, allow?: readonly string[]): StoredBlock[] {
  const taken = new Set<string>();
  let count = 0;
  const walk = (list: unknown, allowed: readonly string[] | undefined, depth: number, place: string): StoredBlock[] => {
    if (!Array.isArray(list) || depth > PAGE_LIMITS.depth) return [];
    const blocks: StoredBlock[] = [];
    for (const [index, item] of list.entries()) {
      if (!isRecord(item) || count >= PAGE_LIMITS.blocks) continue;
      const spec = blockSpec(item.type);
      if (!spec || (allowed && !allowed.includes(item.type as string))) continue;
      count++;
      const type = item.type as string;
      const raw = isRecord(item.props) ? item.props : {};
      let id = typeof raw.id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(raw.id) && !taken.has(raw.id) ? raw.id : `${type}-${place}${index}`;
      while (taken.has(id)) id = `${id}x`;
      taken.add(id);
      const props = parseProps(spec.fields, raw, (inner, innerAllow) => walk(inner, innerAllow, depth + 1, `${place}${index}-`));
      blocks.push({ type, props: { ...props, id } });
    }
    return blocks;
  };
  return walk(items, allow, 0, "");
}

/** A complete, valid page from whatever was stored or sent. */
export function parsePage(input: unknown): PageContent {
  const raw = isRecord(input) ? input : {};
  const meta = isRecord(raw.meta) ? raw.meta : {};
  return {
    meta: {
      title: cleanLine(meta.title, PAGE_LIMITS.metaTitle),
      description: cleanLine(meta.description, PAGE_LIMITS.metaDescription),
      hidden: meta.hidden === true,
    },
    blocks: parseBlocks(raw.blocks),
  };
}

/** Visit every block of a list, and the blocks inside each, in the order they are on the page. */
export function eachBlock(blocks: StoredBlock[], visit: (block: StoredBlock) => void): void {
  for (const block of blocks) {
    visit(block);
    const spec = blockSpec(block.type);
    if (!spec) continue;
    for (const [name, field] of Object.entries(spec.fields)) {
      if (field.kind === "slot" && Array.isArray(block.props[name])) eachBlock(block.props[name] as StoredBlock[], visit);
    }
  }
}

/** The pictures and collections a page names, wherever in it. */
export function pageReferences(content: PageContent): { pictures: string[]; collections: string[] } {
  const into = { pictures: new Set<string>(), collections: new Set<string>() };
  eachBlock(content.blocks, (block) => {
    const spec = blockSpec(block.type);
    if (spec) referencedIds(spec.fields, block.props, into);
  });
  return { pictures: [...into.pictures], collections: [...into.collections] };
}

// ── Addresses ────────────────────────────────────────────────────────────────

/**
 * First parts of an address that belong to the site itself: the booking
 * steps, the account, the admin and the files it serves. A page cannot have
 * an address that starts with one of them. The public pages that are still
 * written in the code are listed too, until they become pages of this kind.
 */
export const RESERVED_SEGMENTS: readonly string[] = [
  "_next",
  "account",
  "admin",
  "api",
  "book",
  "booking",
  "dev",
  "font-files",
  "media",
  "pay",
  "staff",
  "favicon.ico",
  "robots.txt",
  "sitemap.xml",
  // Written in the code for now:
  "contact",
  "faq",
  "policies",
  "rates",
  "services",
  "studios",
];

export type SlugResult = { ok: true; slug: string } | { ok: false; message: string };

/**
 * The address of a page, without the slash it starts with: "gift-cards",
 * "studios/decor". Small letters, digits and hyphens, in up to three parts.
 */
export function parseSlug(input: unknown): SlugResult {
  if (typeof input !== "string") return { ok: false, message: "Give the page an address." };
  const slug = input.trim().toLowerCase().replace(/^\/+|\/+$/g, "");
  if (slug === "") return { ok: false, message: "Give the page an address." };
  if (slug.length > PAGE_LIMITS.slug) return { ok: false, message: "That address is too long." };
  const parts = slug.split("/");
  if (parts.length > 3) return { ok: false, message: "An address has three parts at most: one/two/three." };
  for (const part of parts) {
    if (part.length > PAGE_LIMITS.segment || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(part)) {
      return { ok: false, message: "An address is made of small letters, digits and hyphens: gift-cards, or studios/decor." };
    }
  }
  if (RESERVED_SEGMENTS.includes(parts[0])) {
    return { ok: false, message: `An address cannot start with "${parts[0]}": the site uses that itself.` };
  }
  return { ok: true, slug };
}

/** An address made from a page's name: "Gift Cards & More" -> "gift-cards-more". "page" when the name has no letters. */
export function slugFromTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PAGE_LIMITS.segment)
    .replace(/-+$/, "");
  return slug === "" || RESERVED_SEGMENTS.includes(slug) ? `${slug || "page"}${slug ? "-page" : ""}` : slug;
}

/** "gift-cards" -> "/gift-cards". */
export const pagePath = (slug: string) => `/${slug}`;
