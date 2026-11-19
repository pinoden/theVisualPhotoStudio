import { asc, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { media, mediaCollections } from "@/db/schema";
import { startProps, type StoredBlock } from "@/lib/site/blocks/fields";
import { BLOCKS, type BlockName } from "@/lib/site/blocks/registry";
import { eachBlock } from "@/lib/site/page";
import type { AuthUser } from "./auth";
import { listPages, listPageVersions, loadPageForEditing, savePageDraft } from "./pages";

/**
 * The old website's pictures shown the way it showed them (the owner, on
 * 2026-11-19: "Image wise the websites look too different"). The photos are
 * the ones `old-site-import.ts` brought into the media library, found here by
 * their names there; nothing is uploaded. What changes, page by page:
 *
 *  - the home page: Studio Paris's first photo across the top, behind the
 *    title, as the old site's slideshow opened; the studios as arches; while
 *    the season lasts, the Christmas setups with the old site's words about
 *    them; and the old home page's gallery of ten photos, under the old
 *    site's line about Instagram;
 *  - the photography page: the portfolio's first photo, large, under the
 *    title, and the portfolio in one row that scrolls sideways, as the old
 *    site's slideshow;
 *  - the price page: the sofa photo across its title band.
 *
 * The studios page needs nothing here: its block shows a studio's photos the
 * old site's way by itself.
 *
 * Each change is made once. A block added here has an id starting with
 * `old-site-look`, and is not added again; a picture already chosen, by the
 * owners or by an earlier run, is kept. A page with changes waiting for the
 * owners is left alone. The pages are saved as drafts, to be published in the
 * page editor, which checks them on phones first.
 */

export const LOOK_ID = "old-site-look";

/** The library's names of the photos placed here. */
export const LOOK_PHOTOS = {
  homeHero: "studio-paris-01.jpg",
  christmasLeft: "christmas-setup-01.webp",
  christmasRight: "christmas-setup-02.webp",
  servicesLead: "photography-portfolio-01.jpg",
  ratesBand: "studio-sofa.jpg",
} as const;

/** The library's collection shown on the home page as the old site's gallery. */
export const HOME_GALLERY = "Home page gallery (old website)";

/** The last day the old site's Christmas setups were offered: after it, the Christmas section is not added. */
export const CHRISTMAS_UNTIL = "2027-01-02";

/** The old site's words about the Christmas setups (its home page, read on 2026-11-19), as they were. */
export const CHRISTMAS_WORDS = {
  eyebrow: "Upcoming Installations",
  heading: "Christmas Setups 2026",
  text: [
    "<p>This holiday season, Studio Paris and Studio Dayglow will each transform into their own unique Christmas experience.</p>",
    "<p><strong>Studio Paris</strong> will feature a rich, nostalgic holiday setting with deep reds, velvet textures, vintage details, and classic Christmas charm.</p>",
    "<p><strong>Studio Dayglow</strong> will take on a softer, whimsical feel with natural tones, storybook-inspired details, and two cozy holiday setups, including a magical children’s corner.</p>",
    "<p><strong>Available October 1 - January 2, 2027</strong></p>",
  ].join(""),
};

/** The old site's line over its home page's gallery. */
export const INSTAGRAM_WORDS = { eyebrow: "Follow us on Instagram", heading: "@thevisuals.photostudio" };

/** What the changes need from the library: the photos' ids by their names, and the home gallery's collection. */
export interface LookLibrary {
  photos: Partial<Record<keyof typeof LOOK_PHOTOS, string>>;
  homeGallery?: string;
}

export interface PageLook {
  blocks: StoredBlock[];
  /** What was changed, in words. Empty when the page has it all already. */
  changes: string[];
}

function makeBlock(type: BlockName, id: string, props: Record<string, unknown>): StoredBlock {
  return { type, props: { ...startProps(BLOCKS[type].fields), ...props, id } };
}

/** The ids of every block on a page, the ones inside others included. */
function idsOf(blocks: StoredBlock[]): Set<string> {
  const ids = new Set<string>();
  eachBlock(blocks, (block) => ids.add(block.props.id));
  return ids;
}

/** The first block of a type, wherever it is; changed in place in the copy `blocks` is. */
function firstOf(blocks: StoredBlock[], type: BlockName, also: (block: StoredBlock) => boolean = () => true): StoredBlock | undefined {
  let found: StoredBlock | undefined;
  eachBlock(blocks, (block) => {
    if (!found && block.type === type && also(block)) found = block;
  });
  return found;
}

/** Whether a top-level block holds, at any depth, a block of one of these types. */
function holds(block: StoredBlock, types: BlockName[]): boolean {
  let found = false;
  eachBlock([block], (inner) => {
    if (types.includes(inner.type as BlockName)) found = true;
  });
  return found;
}

/** A page's blocks copied through, so that a change never reaches what was loaded. */
const copy = (blocks: StoredBlock[]): StoredBlock[] => structuredClone(blocks);

/** Give a title band a picture behind it, unless it has one. */
function pictureBehind(banner: StoredBlock | undefined, picture: string | undefined, what: string, changes: string[]): void {
  if (!banner || !picture) return;
  if (typeof banner.props.picture === "string" && banner.props.picture !== "") return;
  banner.props.picture = picture;
  changes.push(what);
}

export function homeLook(loaded: StoredBlock[], library: LookLibrary, today: string): PageLook {
  const blocks = copy(loaded);
  const changes: string[] = [];
  const taken = idsOf(blocks);

  pictureBehind(firstOf(blocks, "Banner"), library.photos.homeHero, "Studio Paris's first photo across the top, behind the title", changes);

  const cards = firstOf(blocks, "StudioCards");
  if (cards && cards.props.look !== "arches") {
    cards.props.look = "arches";
    changes.push("the studios as arches");
  }

  // The Christmas setups, as the old home page had them under its first words: a photo either side of what it said.
  const christmasId = `${LOOK_ID}-christmas`;
  const { christmasLeft, christmasRight } = library.photos;
  if (!taken.has(christmasId) && christmasLeft && christmasRight && today <= CHRISTMAS_UNTIL) {
    const tall = { shape: "original", corners: "square", size: "full" };
    const section = makeBlock("Section", christmasId, {
      background: "card",
      content: [
        makeBlock("Heading", `${christmasId}-heading`, { eyebrow: CHRISTMAS_WORDS.eyebrow, text: CHRISTMAS_WORDS.heading, line: true }),
        makeBlock("Columns", `${christmasId}-columns`, {
          count: "3",
          shape: "even",
          gap: "large",
          middle: "center",
          one: [makeBlock("Picture", `${christmasId}-left`, { ...tall, picture: christmasLeft })],
          two: [makeBlock("Text", `${christmasId}-text`, { text: CHRISTMAS_WORDS.text, size: "small" })],
          three: [makeBlock("Picture", `${christmasId}-right`, { ...tall, picture: christmasRight })],
        }),
      ],
    });
    const banner = blocks.findIndex((block) => block.type === "Banner");
    blocks.splice(banner + 1, 0, section);
    changes.push("the Christmas setups under the title, until January 2");
  }

  // The old home page's gallery, under its line about Instagram: before the studio's address, as there.
  const galleryId = `${LOOK_ID}-instagram`;
  if (!taken.has(galleryId) && library.homeGallery) {
    const section = makeBlock("Section", galleryId, {
      background: "page",
      content: [
        makeBlock("Heading", `${galleryId}-heading`, { eyebrow: INSTAGRAM_WORDS.eyebrow, text: INSTAGRAM_WORDS.heading }),
        makeBlock("Gallery", `${galleryId}-gallery`, { source: "collection", collection: library.homeGallery, layout: "grid", columns: 4, columnsPhone: 2, shape: "tall", gap: "small" }),
      ],
    });
    const address = blocks.findIndex((block) => holds(block, ["ContactDetails", "LocationCard"]));
    blocks.splice(address === -1 ? blocks.length : address, 0, section);
    changes.push("the old home page's gallery, before the address");
  }
  return { blocks, changes };
}

export function servicesLook(loaded: StoredBlock[], library: LookLibrary): PageLook {
  const blocks = copy(loaded);
  const changes: string[] = [];
  const leadId = `${LOOK_ID}-lead`;
  if (!idsOf(blocks).has(leadId) && library.photos.servicesLead) {
    const section = makeBlock("Section", leadId, {
      background: "page",
      space: "small",
      content: [makeBlock("Picture", `${leadId}-picture`, { picture: library.photos.servicesLead, shape: "standard", focus: "top", size: "large" })],
    });
    const banner = blocks.findIndex((block) => block.type === "Banner");
    blocks.splice(banner + 1, 0, section);
    changes.push("the portfolio's first photo, large, under the title");
  }
  // The portfolio the old import put on the page, in one row that scrolls sideways. Its number for phones is left as it
  // is (none): a row shows one at a time on a phone by itself, and code that draws no rows yet keeps two in a line there,
  // not twenty-five one under another.
  const portfolio = firstOf(blocks, "Gallery", (block) => block.props.id.startsWith("old-site-gallery") && block.props.source === "collection");
  if (portfolio && portfolio.props.layout !== "row") {
    Object.assign(portfolio.props, { layout: "row", columns: 3, gap: "small" });
    changes.push("the portfolio in one row that scrolls sideways");
  }
  return { blocks, changes };
}

export function ratesLook(loaded: StoredBlock[], library: LookLibrary): PageLook {
  const blocks = copy(loaded);
  const changes: string[] = [];
  pictureBehind(firstOf(blocks, "Banner"), library.photos.ratesBand, "the sofa photo across the title band", changes);
  return { blocks, changes };
}

export interface PageLookReport {
  path: string;
  title: string;
  /** What was changed, in words: empty when nothing was. */
  changes: string[];
  /** Why the page was left alone, when it was. */
  skipped?: string;
  /** The page's id, and the draft's revision to publish. */
  id?: string;
  revision?: number;
  /** The version the website showed before: what "Restore" in the page's history brings back. */
  versionBefore?: number;
}

export type LookResult = { ok: true; pages: PageLookReport[]; missing: string[] } | { ok: false; message: string };

/** The library's ids of the photos and the collection the changes place, and the names not found. */
export async function lookLibrary(db: Db): Promise<{ library: LookLibrary; missing: string[] }> {
  // By the name without its ending as well: the library gives a file the ending of what it really is.
  const stem = (name: string) => name.replace(/\.[a-z0-9]+$/i, "");
  const files = await db.select({ id: media.id, filename: media.filename }).from(media).orderBy(asc(media.createdAt));
  const library: LookLibrary = { photos: {} };
  const missing: string[] = [];
  for (const [key, name] of Object.entries(LOOK_PHOTOS) as [keyof typeof LOOK_PHOTOS, string][]) {
    const file = files.find((row) => row.filename === name) ?? files.find((row) => stem(row.filename) === stem(name));
    if (file) library.photos[key] = file.id;
    else missing.push(`the photo ${name}`);
  }
  const [gallery] = await db.select({ id: mediaCollections.id }).from(mediaCollections).where(inArray(mediaCollections.name, [HOME_GALLERY]));
  if (gallery) library.homeGallery = gallery.id;
  else missing.push(`the collection ${HOME_GALLERY}`);
  return { library, missing };
}

/** Put the old website's pictures where it showed them, in the drafts of the home, photography and price pages. */
export async function applyOldSiteLook(db: Db, viewer: AuthUser, now: Date): Promise<LookResult> {
  if (viewer.role !== "owner") return { ok: false, message: "Only an owner changes the website's pages here." };
  const pages = await listPages(db, viewer);
  if (!pages) return { ok: false, message: "These pages cannot be changed by this person." };
  const { library, missing } = await lookLibrary(db);
  const today = now.toISOString().slice(0, 10);
  const plans: { slug: string; look: (blocks: StoredBlock[]) => PageLook }[] = [
    { slug: "", look: (blocks) => homeLook(blocks, library, today) },
    { slug: "services", look: (blocks) => servicesLook(blocks, library) },
    { slug: "rates", look: (blocks) => ratesLook(blocks, library) },
  ];
  const reports: PageLookReport[] = [];
  for (const plan of plans) {
    const path = `/${plan.slug}`;
    const page = pages.find((row) => row.slug === plan.slug);
    if (!page) {
      reports.push({ path, title: path, changes: [], skipped: "there is no such page" });
      continue;
    }
    const state = await loadPageForEditing(db, viewer, page.id, now);
    if (!state) {
      reports.push({ path, title: page.title, changes: [], skipped: "the page could not be opened for editing" });
      continue;
    }
    if (!state.isLive) {
      reports.push({ path, title: state.title, changes: [], skipped: "the page is not on the website" });
      continue;
    }
    if (state.hasDraft) {
      reports.push({ path, title: state.title, changes: [], skipped: "the page has changes waiting for the owners: nothing was changed" });
      continue;
    }
    const { blocks, changes } = plan.look(state.content.blocks);
    const versions = (await listPageVersions(db, viewer, page.id, 1)) ?? [];
    const report: PageLookReport = { path, title: state.title, changes, id: page.id, revision: state.revision, versionBefore: versions[0]?.number };
    if (changes.length > 0) {
      const saved = await savePageDraft(db, viewer, page.id, { ...state.content, blocks }, { basedOn: state.revision, now });
      if (!saved.ok) {
        reports.push({ ...report, changes: [], skipped: saved.message });
        continue;
      }
      report.revision = saved.revision;
    }
    reports.push(report);
  }
  return { ok: true, pages: reports, missing };
}
