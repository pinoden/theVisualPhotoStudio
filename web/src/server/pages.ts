import { and, asc, desc, eq, isNotNull, isNull, lt, max, ne, sql } from "drizzle-orm";
import { media, mediaCollections, siteDocuments, siteRedirects, siteVersions } from "@/db/schema";
import { together, type Db, type DbLike } from "@/db/client";
import { can } from "@/lib/abilities";
import type { SiteContext } from "@/lib/site/blocks/block";
import { cleanLine, frameLinksTo, parseHref } from "@/lib/site/frame";
import { liveValues } from "@/lib/site/live-values";
import { PAGE_LIMITS, pageLinksTo, pagePath, pageReferences, parsePage, parseSlug, RESERVED_SEGMENTS, slugFromTitle, type PageContent } from "@/lib/site/page";
import { builtInPage, builtInPages } from "@/lib/site/built-in-pages";
import { conditionsOf } from "@/lib/site/conditions";
import { paragraphs } from "@/lib/site/rich-text";
import type { AuthUser } from "./auth";
import { loadCatalog } from "./catalog";
import { collectionShows, loadCollection } from "./collections";
import { loadPictures } from "./media";
import { loadSettings } from "./settings";
import { localDateOf } from "./tz";
import { DRAFT_CHANGED, FRAME_DOC, loadBusiness, loadDraftOrPublished, loadPublished, type VersionSummary } from "./website";

/**
 * The website's pages: the ones the owners make and edit, each a list of
 * blocks (src/lib/site/page.ts), at an address of its own.
 *
 * A page is a row of `site_documents` like the design, with the same life:
 * a draft only the admin sees, a published copy the public sees, and a full
 * copy of every publish in `site_versions`. Two things are different. A page
 * that was never published, or was taken offline, has no published copy and
 * is not on the website at all. And a page has an address and a name, which
 * change at once, not through a draft: an old address of a published page
 * keeps working, because a redirect is written for it.
 *
 * A deleted page waits in the trash for `TRASH_DAYS`, from where it can be
 * brought back; its address is free at once.
 *
 * The pages the website was built with (src/lib/site/built-in-pages.ts) are
 * pages like these, with three differences. `ensureBuiltInPages` puts each
 * into a database once. One of them can start again from how it was built.
 * And one deleted waits in the trash for good, never removed, so that it
 * cannot come back by itself. The home page, at "/", is one of them: it
 * cannot move, leave the website or be deleted, because the website's own
 * address shows it.
 *
 * Every function that changes something checks the viewer itself. Editing
 * needs `editPages`; whatever changes what the public sees (publishing,
 * taking offline, deleting or moving a published page) needs `publishWebsite`
 * as well. After such a change the caller refreshes the cached pages.
 */

/** How long a deleted page can be brought back. */
export const TRASH_DAYS = 30;

type Row = typeof siteDocuments.$inferSelect;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const isPage = eq(siteDocuments.kind, "page");
const notDeleted = isNull(siteDocuments.deletedAt);

async function abilities(db: DbLike, viewer: { role: string }): Promise<{ edit: boolean; publish: boolean }> {
  const settings = await loadSettings(db);
  const edit = can(viewer, "editPages", settings);
  return { edit, publish: edit && can(viewer, "publishWebsite", settings) };
}

/** Who published a page the website was built with, in its history. */
export const AS_BUILT = "the site as it was built";

/** What `restorePageVersion` is given, in place of a version's id, to start again from how a page was built. */
export const BUILT_VERSION = "built";

const isHome = (row: Row) => row.slug === "";

const CANNOT_EDIT = "You cannot change the website's pages.";
const CANNOT_PUBLISH = "You cannot change what is published on the website. An owner can.";
const NOT_FOUND = "That page was not found.";

async function pageRow(db: DbLike, id: string, lock = false): Promise<Row | null> {
  if (!isUuid(id)) return null;
  const query = db.select().from(siteDocuments).where(and(isPage, notDeleted, eq(siteDocuments.id, id))).limit(1);
  const [row] = lock ? await query.for("update") : await query;
  return row ?? null;
}

/** An address no other page has: `wanted` itself, or with "-2", "-3" after it. */
async function freeSlug(db: DbLike, wanted: string, except?: string): Promise<string> {
  const taken = new Set(
    (
      await db
        .select({ slug: siteDocuments.slug })
        .from(siteDocuments)
        .where(and(isPage, notDeleted, except ? ne(siteDocuments.id, except) : undefined))
    ).map((row) => row.slug),
  );
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; n < 500; n++) {
    const candidate = `${wanted.slice(0, PAGE_LIMITS.slug - 4)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${wanted.slice(0, 60)}-${Date.now()}`;
}

// ── What a page needs to be drawn ────────────────────────────────────────────

/**
 * What a page's blocks read besides their own values: the pictures and
 * collections it names, the studio's data (studios, prices, hours, add-ons,
 * settings) and contact details, and the live values its text can name.
 */
export async function pageSite(db: DbLike, content: PageContent, now: Date): Promise<SiteContext> {
  const references = pageReferences(content);
  const today = localDateOf(now);
  const collections: SiteContext["collections"] = {};
  const pictureIds = new Set(references.pictures);
  for (const id of references.collections) {
    const collection = await loadCollection(db, id);
    if (!collection) continue;
    collections[id] = { name: collection.name, pictures: collection.pictures.map((picture) => picture.id), shows: collectionShows(collection, today) };
    for (const picture of collection.pictures) pictureIds.add(picture.id);
  }
  const [pictures, catalog, business] = await together(db, [() => loadPictures(db, [...pictureIds]), () => loadCatalog(db), () => loadBusiness(db)]);
  const values = Object.fromEntries(liveValues(catalog, business).map((entry) => [entry.name, entry.value]));
  return { pictures: Object.fromEntries(pictures), collections, catalog, business, values, conditions: conditionsOf(catalog) };
}

/**
 * What the page editor needs to draw a page while it is changed: the pictures
 * the page names, and every collection with its pictures, so that any
 * collection can be chosen and shown at once.
 */
export async function pageEditorContext(db: DbLike, content: PageContent, now: Date): Promise<{ site: SiteContext; collections: { id: string; name: string }[] }> {
  const site = await pageSite(db, content, now);
  const rows = await db.select({ id: mediaCollections.id, name: mediaCollections.name }).from(mediaCollections).orderBy(asc(mediaCollections.name));
  const today = localDateOf(now);
  for (const row of rows) {
    if (site.collections[row.id]) continue;
    const collection = await loadCollection(db, row.id);
    if (!collection) continue;
    site.collections[row.id] = { name: collection.name, pictures: collection.pictures.map((picture) => picture.id), shows: collectionShows(collection, today) };
    for (const picture of collection.pictures) site.pictures[picture.id] = picture;
  }
  return { site, collections: rows };
}

export interface ShownPage {
  id: string;
  slug: string;
  /** The page's name: its title on the browser's tab unless it has one of its own. */
  title: string;
  content: PageContent;
  site: SiteContext;
}

async function shown(db: DbLike, row: Row, content: PageContent, now: Date): Promise<ShownPage> {
  return { id: row.id, slug: row.slug, title: row.title, content, site: await pageSite(db, content, now) };
}

async function rowBySlug(db: DbLike, slug: string): Promise<Row | null> {
  const [row] = await db.select().from(siteDocuments).where(and(isPage, notDeleted, eq(siteDocuments.slug, slug))).limit(1);
  return row ?? null;
}

/** The published page at an address, for the public. Null when there is none: no such page, or one that is not published. */
export async function loadPublishedPage(db: DbLike, slug: string, now: Date): Promise<ShownPage | null> {
  const row = await rowBySlug(db, slug);
  return row?.published != null ? shown(db, row, parsePage(row.published), now) : null;
}

/** The page at an address as a preview shows it: its draft when it has one, otherwise what is published. */
export async function loadPagePreview(db: DbLike, slug: string, now: Date): Promise<ShownPage | null> {
  const row = await rowBySlug(db, slug);
  if (!row) return null;
  const content = row.draft != null ? row.draft : row.published;
  return content != null ? shown(db, row, parsePage(content), now) : null;
}

/** The addresses of every published page, without the slash they start with. */
export async function publishedSlugs(db: DbLike): Promise<string[]> {
  const rows = await db.select({ slug: siteDocuments.slug }).from(siteDocuments).where(and(isPage, notDeleted, isNotNull(siteDocuments.published))).orderBy(asc(siteDocuments.slug));
  return rows.map((row) => row.slug);
}

/**
 * The pages a change of the design, or of the header, menu and footer, is
 * measured on before it is published (src/components/site-editor/phone-check.ts):
 * every published page, hidden ones included, for they are public at their
 * address all the same; the two booking screens; and the account. The home
 * page first.
 */
export async function websiteCheckPaths(db: DbLike): Promise<string[]> {
  const pages = (await publishedSlugs(db)).map(pagePath);
  return [...new Set(["/", ...pages, "/book", "/book/photography", "/account"])];
}

/** The published pages a search engine may list, with when each was last published. */
export async function listedPages(db: DbLike): Promise<{ path: string; publishedAt: Date | null }[]> {
  const rows = await db.select().from(siteDocuments).where(and(isPage, notDeleted, isNotNull(siteDocuments.published))).orderBy(asc(siteDocuments.slug));
  return rows.filter((row) => !parsePage(row.published).meta.hidden).map((row) => ({ path: pagePath(row.slug), publishedAt: row.publishedAt }));
}

// ── The list ─────────────────────────────────────────────────────────────────

export interface PageSummary {
  id: string;
  slug: string;
  path: string;
  title: string;
  /** `draft`: not on the website. `live`: on the website as it is here. `changed`: on the website, with changes waiting. */
  state: "draft" | "live" | "changed";
  /** True when search engines are asked not to list it. */
  hidden: boolean;
  draftBy: string | null;
  draftAt: string | null;
  publishedBy: string | null;
  publishedAt: string | null;
  deletedAt: string | null;
  /** True for a page the website was built with. */
  builtIn: boolean;
  /** True for the home page, which keeps its address and stays on the website. */
  home: boolean;
}

function summary(row: Row): PageSummary {
  return {
    id: row.id,
    slug: row.slug,
    builtIn: row.builtIn != null,
    home: isHome(row),
    path: pagePath(row.slug),
    title: row.title,
    state: row.published == null ? "draft" : row.draft == null ? "live" : "changed",
    hidden: parsePage(row.published ?? row.draft).meta.hidden,
    draftBy: row.draftBy,
    draftAt: row.draftAt?.toISOString() ?? null,
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

/** Every page, by name. Null for someone who may not edit pages. */
export async function listPages(db: DbLike, viewer: { role: string }): Promise<PageSummary[] | null> {
  if (!(await abilities(db, viewer)).edit) return null;
  const rows = await db.select().from(siteDocuments).where(and(isPage, notDeleted)).orderBy(asc(siteDocuments.title), asc(siteDocuments.slug));
  return rows.map(summary);
}

/** The pages in the trash, the one deleted last first. Null for someone who may not edit pages. */
export async function listTrash(db: DbLike, viewer: { role: string }): Promise<PageSummary[] | null> {
  if (!(await abilities(db, viewer)).edit) return null;
  const rows = await db.select().from(siteDocuments).where(and(isPage, isNotNull(siteDocuments.deletedAt))).orderBy(desc(siteDocuments.deletedAt));
  return rows.map(summary);
}

/**
 * The pages a link can lead to, for whoever edits a link: the pages that are
 * published, and the ones that are not yet, marked as such.
 */
export async function linkablePages(db: DbLike): Promise<{ path: string; title: string; live: boolean }[]> {
  const rows = await db.select().from(siteDocuments).where(and(isPage, notDeleted)).orderBy(asc(siteDocuments.title));
  return rows.map((row) => ({ path: pagePath(row.slug), title: row.title, live: row.published != null }));
}

// ── Making pages ─────────────────────────────────────────────────────────────

export type PageResult = { ok: true; id: string } | { ok: false; message: string };

/** What a new page starts with: a section holding its title and a line of text to replace. */
function starter(title: string): PageContent {
  return parsePage({
    blocks: [
      {
        type: "Section",
        props: {
          content: [
            { type: "Heading", props: { text: title, level: "h1", line: true } },
            { type: "Text", props: { text: paragraphs("Write here. Add more blocks from the list on the left.") } },
          ],
        },
      },
    ],
  });
}

/**
 * Make a new page. It starts as a draft: it is not on the website until it
 * is published. With no address given, one is made from the name.
 */
export async function createPage(db: Db, viewer: AuthUser, input: { title: string; slug?: string }, now: Date): Promise<PageResult> {
  if (!(await abilities(db, viewer)).edit) return { ok: false, message: CANNOT_EDIT };
  const title = cleanLine(input.title, PAGE_LIMITS.title);
  if (!title) return { ok: false, message: "Give the page a name." };
  const typed = (input.slug ?? "").trim();
  const parsed = parseSlug(typed === "" ? slugFromTitle(title) : typed);
  if (!parsed.ok) return parsed;
  return db.transaction(async (tx): Promise<PageResult> => {
    const slug = await freeSlug(tx, parsed.slug);
    // An address someone typed is theirs to choose again; one the site made is made free.
    if (typed !== "" && slug !== parsed.slug) return { ok: false, message: `Another page already has the address /${parsed.slug}.` };
    const [row] = await tx
      .insert(siteDocuments)
      .values({ kind: "page", slug, title, draft: starter(title), draftRevision: 1, draftBy: viewer.email, draftAt: now, createdAt: now })
      .returning({ id: siteDocuments.id });
    return { ok: true, id: row.id };
  });
}

/** Make a copy of a page, as a draft with an address of its own: a page used as a template for another. */
export async function duplicatePage(db: Db, viewer: AuthUser, id: string, now: Date): Promise<PageResult> {
  if (!(await abilities(db, viewer)).edit) return { ok: false, message: CANNOT_EDIT };
  return db.transaction(async (tx): Promise<PageResult> => {
    const row = await pageRow(tx, id);
    if (!row) return { ok: false, message: NOT_FOUND };
    const title = cleanLine(`Copy of ${row.title}`, PAGE_LIMITS.title);
    const slug = await freeSlug(tx, `${(isHome(row) ? "home" : row.slug).slice(0, PAGE_LIMITS.slug - 10)}-copy`);
    const [copy] = await tx
      .insert(siteDocuments)
      .values({ kind: "page", slug, title, draft: parsePage(row.draft ?? row.published), draftRevision: 1, draftBy: viewer.email, draftAt: now, createdAt: now })
      .returning({ id: siteDocuments.id });
    return { ok: true, id: copy.id };
  });
}

// ── Editing a page ───────────────────────────────────────────────────────────

export interface PageEditingState {
  id: string;
  slug: string;
  path: string;
  title: string;
  /** What the editor opens with: the draft when there is one, otherwise what is published. */
  content: PageContent;
  /** True while there are changes the public cannot see: a draft of a published page, or a page that is not published. */
  hasDraft: boolean;
  /** True while the page is on the website. */
  isLive: boolean;
  revision: number;
  draftBy: string | null;
  draftAt: string | null;
  publishedBy: string | null;
  publishedAt: string | null;
  /** The pictures and collections the page names, for drawing it in the editor. */
  site: SiteContext;
  may: { publish: boolean };
  /** True for a page the website was built with, which can start again from how it was built. */
  builtIn: boolean;
  /** True for the home page, which keeps its address and stays on the website. */
  home: boolean;
}

/** A page as its editor needs it. Null for someone who may not edit pages, and for a page that is not there. */
export async function loadPageForEditing(db: DbLike, viewer: AuthUser, id: string, now: Date): Promise<PageEditingState | null> {
  const may = await abilities(db, viewer);
  if (!may.edit) return null;
  const row = await pageRow(db, id);
  if (!row) return null;
  const content = parsePage(row.draft ?? row.published);
  return {
    id: row.id,
    slug: row.slug,
    path: pagePath(row.slug),
    title: row.title,
    content,
    hasDraft: row.draft != null,
    isLive: row.published != null,
    revision: row.draftRevision,
    draftBy: row.draftBy,
    draftAt: row.draftAt?.toISOString() ?? null,
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    site: await pageSite(db, content, now),
    may: { publish: may.publish },
    builtIn: row.builtIn != null,
    home: isHome(row),
  };
}

export type SavePageResult =
  | { ok: true; revision: number; hasDraft: boolean; savedAt: string }
  | { ok: false; reason: "forbidden" | "missing"; message: string }
  /** `waiting`: a draft waits now; when none does, it was published, discarded or set back somewhere else. */
  | { ok: false; reason: "conflict"; message: string; by: string | null; at: string | null; waiting: boolean };

/**
 * Store `input` as the page's draft. As for the design (`saveDraft` in
 * website.ts): `basedOn` is the revision the editor loaded, and a draft that
 * changed since is not overwritten unless `force` says so.
 */
export async function savePageDraft(
  db: Db,
  viewer: AuthUser,
  id: string,
  input: unknown,
  options: { basedOn: number; force?: boolean; now: Date },
): Promise<SavePageResult> {
  if (!(await abilities(db, viewer)).edit) return { ok: false, reason: "forbidden", message: CANNOT_EDIT };
  const content = parsePage(input);
  return db.transaction(async (tx): Promise<SavePageResult> => {
    const row = await pageRow(tx, id, true);
    if (!row) return { ok: false, reason: "missing", message: "This page is no longer there. Someone may have deleted it." };
    if (!options.force && row.draftRevision !== options.basedOn) {
      return {
        ok: false,
        reason: "conflict",
        message: "This was changed somewhere else since you opened it.",
        // Who saved the draft that waits. With none waiting it was published, discarded or set back, by whoever: nobody is named.
        by: row.draft != null ? row.draftBy : null,
        at: row.draft != null ? (row.draftAt?.toISOString() ?? null) : null,
        waiting: row.draft != null,
      };
    }
    // A page that is not published is all draft. A published one has a draft only while it differs from what is published.
    const hasDraft = row.published == null || !same(content, parsePage(row.published));
    if (hasDraft ? row.draft != null && same(content, parsePage(row.draft)) : row.draft == null) {
      return { ok: true, revision: row.draftRevision, hasDraft, savedAt: (row.draftAt ?? options.now).toISOString() };
    }
    const revision = row.draftRevision + 1;
    await tx
      .update(siteDocuments)
      .set({ draft: hasDraft ? content : null, draftRevision: revision, draftBy: hasDraft ? viewer.email : null, draftAt: hasDraft ? options.now : null })
      .where(eq(siteDocuments.id, row.id));
    return { ok: true, revision, hasDraft, savedAt: options.now.toISOString() };
  });
}

export type PublishPageResult = { ok: true; version: number; path: string } | { ok: false; message: string };

/**
 * Put the page on the website as its draft has it, and keep a copy as a
 * version. A page whose pictures do not all say what they show is not
 * published: the answer names them. `basedOn` is the revision of the draft
 * the editor checked on phones, as for `publishDraft`.
 */
export async function publishPage(db: Db, viewer: AuthUser, id: string, now: Date, basedOn?: number): Promise<PublishPageResult> {
  if (!(await abilities(db, viewer)).publish) return { ok: false, message: CANNOT_PUBLISH };
  return db.transaction(async (tx): Promise<PublishPageResult> => {
    const row = await pageRow(tx, id, true);
    if (!row) return { ok: false, message: NOT_FOUND };
    // The editor checked the draft at this revision on phones: one changed since is not published unchecked.
    if (basedOn !== undefined && row.draftRevision !== basedOn) return { ok: false, message: DRAFT_CHANGED };
    if (row.draft == null) return { ok: false, message: "There is nothing to publish: the website already shows this page as it is here." };
    const content = parsePage(row.draft);
    const site = await pageSite(tx, content, now);
    const silent = Object.values(site.pictures).filter((picture) => picture.alt.trim() === "");
    if (silent.length > 0) {
      const names = (await tx.select({ id: media.id, filename: media.filename }).from(media))
        .filter((file) => silent.some((picture) => picture.id === file.id))
        .map((file) => file.filename);
      return {
        ok: false,
        message: `Not published: ${names.length === 1 ? `the picture ${names[0]} does` : `these pictures do`} not say what ${names.length === 1 ? "it shows" : `they show (${names.join(", ")})`}. Describe ${names.length === 1 ? "it" : "them"} under Pictures, then publish.`,
      };
    }
    const [last] = await tx.select({ number: max(siteVersions.number) }).from(siteVersions).where(eq(siteVersions.documentId, row.id));
    const version = (last?.number ?? 0) + 1;
    await tx.insert(siteVersions).values({ documentId: row.id, number: version, content, publishedBy: viewer.email, createdAt: now });
    await tx
      .update(siteDocuments)
      .set({ published: content, publishedBy: viewer.email, publishedAt: now, draft: null, draftBy: null, draftAt: null, draftRevision: row.draftRevision + 1 })
      .where(eq(siteDocuments.id, row.id));
    // The page answers at its address from now on. An old address that led away from it is dropped: taken off the
    // website later, the page would leave it leading on again, perhaps round to where it started.
    await tx.delete(siteRedirects).where(eq(siteRedirects.fromPath, pagePath(row.slug)));
    return { ok: true, version, path: pagePath(row.slug) };
  });
}

export type PageChangeResult = { ok: true; path: string } | { ok: false; message: string };

/** Take a page off the website. It stays here as a draft, with everything that was on it. */
export async function unpublishPage(db: Db, viewer: AuthUser, id: string, now: Date): Promise<PageChangeResult> {
  if (!(await abilities(db, viewer)).publish) return { ok: false, message: CANNOT_PUBLISH };
  return db.transaction(async (tx): Promise<PageChangeResult> => {
    const row = await pageRow(tx, id, true);
    if (!row) return { ok: false, message: NOT_FOUND };
    if (row.published == null) return { ok: false, message: "This page is not on the website." };
    if (isHome(row)) return { ok: false, message: "The home page cannot be taken off the website: the website's own address shows it." };
    await tx
      .update(siteDocuments)
      .set({
        // Changes that were waiting stay the draft; otherwise what was published becomes it.
        draft: row.draft ?? row.published,
        draftBy: row.draftBy ?? viewer.email,
        draftAt: row.draftAt ?? now,
        published: null,
        draftRevision: row.draftRevision + 1,
      })
      .where(eq(siteDocuments.id, row.id));
    return { ok: true, path: pagePath(row.slug) };
  });
}

/**
 * Throw away the changes that are waiting on a published page. A page that
 * was never published has nothing to go back to. The revision moves on even
 * when no draft was stored, so that the editor starts again from what is
 * published, without a change it had not saved yet.
 */
export async function discardPageDraft(db: Db, viewer: AuthUser, id: string): Promise<PageChangeResult> {
  if (!(await abilities(db, viewer)).edit) return { ok: false, message: CANNOT_EDIT };
  return db.transaction(async (tx): Promise<PageChangeResult> => {
    const row = await pageRow(tx, id, true);
    if (!row) return { ok: false, message: NOT_FOUND };
    if (row.published == null) return { ok: false, message: "This page is not published, so there is nothing to go back to. To be rid of it, delete the page." };
    await tx.update(siteDocuments).set({ draft: null, draftBy: null, draftAt: null, draftRevision: row.draftRevision + 1 }).where(eq(siteDocuments.id, row.id));
    return { ok: true, path: pagePath(row.slug) };
  });
}

/** The versions of a page that were published, newest first. Null for someone who may not edit pages, or for no such page. */
export async function listPageVersions(db: DbLike, viewer: AuthUser, id: string, limit = 30): Promise<VersionSummary[] | null> {
  if (!(await abilities(db, viewer)).edit) return null;
  const row = await pageRow(db, id);
  if (!row) return null;
  const versions = await db.select().from(siteVersions).where(eq(siteVersions.documentId, row.id)).orderBy(desc(siteVersions.number)).limit(Math.min(Math.max(limit, 1), 200));
  const published = row.published != null ? parsePage(row.published) : null;
  const currentId = published ? versions.find((version) => same(parsePage(version.content), published))?.id : undefined;
  return versions.map((version) => ({ id: version.id, number: version.number, publishedBy: version.publishedBy, publishedAt: version.createdAt.toISOString(), current: version.id === currentId }));
}

/**
 * Bring an earlier version of a page back as its draft. The website shows
 * what it showed until the draft is published. `BUILT_VERSION` in place of a
 * version's id brings back how a page the website was built with started.
 */
export async function restorePageVersion(db: Db, viewer: AuthUser, id: string, versionId: string, now: Date): Promise<{ ok: true; number: number } | { ok: false; message: string }> {
  if (!(await abilities(db, viewer)).edit) return { ok: false, message: CANNOT_EDIT };
  if (!isUuid(versionId) && versionId !== BUILT_VERSION) return { ok: false, message: "That version was not found." };
  return db.transaction(async (tx) => {
    const row = await pageRow(tx, id, true);
    if (!row) return { ok: false as const, message: NOT_FOUND };
    let content: PageContent;
    let number = 0;
    if (versionId === BUILT_VERSION) {
      const built = builtInPage(row.builtIn);
      if (!built) return { ok: false as const, message: "This page was made here, not built with the website: bring back one of its versions instead." };
      content = parsePage(built.content);
    } else {
      const [version] = await tx.select().from(siteVersions).where(and(eq(siteVersions.id, versionId), eq(siteVersions.documentId, row.id))).limit(1);
      if (!version) return { ok: false as const, message: "That version was not found." };
      content = parsePage(version.content);
      number = version.number;
    }
    const hasDraft = row.published == null || !same(content, parsePage(row.published));
    await tx
      .update(siteDocuments)
      .set({ draft: hasDraft ? content : null, draftBy: hasDraft ? viewer.email : null, draftAt: hasDraft ? now : null, draftRevision: row.draftRevision + 1 })
      .where(eq(siteDocuments.id, row.id));
    return { ok: true as const, number };
  });
}

// ── A page's name and address ────────────────────────────────────────────────

/**
 * Change a page's name and address. They change at once, not through a
 * draft. When a published page gets a new address, the old one is kept
 * working: a redirect is written from it to the new one. `own` are the
 * addresses the website is known by (`siteOrigins`), for old addresses
 * written as a full address of the site.
 */
export async function savePageSettings(
  db: Db,
  viewer: AuthUser,
  id: string,
  input: { title: string; slug: string },
  own: readonly string[] = [],
): Promise<PageChangeResult> {
  const may = await abilities(db, viewer);
  if (!may.edit) return { ok: false, message: CANNOT_EDIT };
  const title = cleanLine(input.title, PAGE_LIMITS.title);
  if (!title) return { ok: false, message: "Give the page a name." };
  return db.transaction(async (tx): Promise<PageChangeResult> => {
    const row = await pageRow(tx, id, true);
    if (!row) return { ok: false, message: NOT_FOUND };
    // The home page keeps its address, whatever was sent: it is the website's own.
    const parsed = isHome(row) ? { ok: true as const, slug: "" } : parseSlug(input.slug);
    if (!parsed.ok) return parsed;
    const moved = parsed.slug !== row.slug;
    if (moved && row.published != null && !may.publish) return { ok: false, message: "This page is on the website, so changing its address changes the website. An owner can." };
    if (moved && (await freeSlug(tx, parsed.slug, row.id)) !== parsed.slug) return { ok: false, message: `Another page already has the address /${parsed.slug}.` };
    await tx.update(siteDocuments).set({ title, slug: parsed.slug }).where(eq(siteDocuments.id, row.id));
    if (moved) {
      const [from, to] = [pagePath(row.slug), pagePath(parsed.slug)];
      // Nothing may lead away from the address a published page now has (a draft leaves it leading on until it is
      // published), and what led to the old address leads on to the new, however it was written.
      if (row.published != null) await tx.delete(siteRedirects).where(eq(siteRedirects.fromPath, to));
      for (const redirect of await tx.select().from(siteRedirects)) {
        if (pathOf(redirect.toPath, own) !== from) continue;
        // To the same place on the page: what followed the path (a #section, a ?query) stays.
        await tx
          .update(siteRedirects)
          .set({ toPath: `${to}${afterPath(redirect.toPath)}` })
          .where(eq(siteRedirects.fromPath, redirect.fromPath));
      }
      if (row.published != null) {
        await tx.insert(siteRedirects).values({ fromPath: from, toPath: to }).onConflictDoUpdate({ target: siteRedirects.fromPath, set: { toPath: to } });
      } else {
        // A draft's new address keeps leading on, unless that leads round to the page itself, which is now there:
        // visitors would go round until their browser gave up. Then the page is where it led, once it is published.
        const onward = await findRedirect(tx, to);
        if (onward !== null && (await roundBack(tx, to, onward, own))) await tx.delete(siteRedirects).where(eq(siteRedirects.fromPath, to));
      }
    }
    return { ok: true, path: pagePath(parsed.slug) };
  });
}

// ── Deleting pages ───────────────────────────────────────────────────────────

/** Put a page in the trash. It leaves the website at once and its address is free; it can be brought back for `TRASH_DAYS`. */
export async function deletePage(db: Db, viewer: AuthUser, id: string, now: Date): Promise<PageChangeResult> {
  const may = await abilities(db, viewer);
  if (!may.edit) return { ok: false, message: CANNOT_EDIT };
  return db.transaction(async (tx): Promise<PageChangeResult> => {
    const row = await pageRow(tx, id, true);
    if (!row) return { ok: false, message: NOT_FOUND };
    if (isHome(row)) return { ok: false, message: "The home page cannot be deleted: the website's own address shows it." };
    if (row.published != null && !may.publish) return { ok: false, message: "This page is on the website, so deleting it changes the website. An owner can." };
    // In the trash a page is a draft: brought back, it is not on the website until it is published again.
    await tx
      .update(siteDocuments)
      .set({ deletedAt: now, draft: row.draft ?? row.published, published: null, draftRevision: row.draftRevision + 1 })
      .where(eq(siteDocuments.id, row.id));
    return { ok: true, path: pagePath(row.slug) };
  });
}

/** Bring a page back from the trash, as a draft. If its address was taken meanwhile it gets a free one. */
export async function restorePage(db: Db, viewer: AuthUser, id: string): Promise<PageChangeResult> {
  if (!(await abilities(db, viewer)).edit) return { ok: false, message: CANNOT_EDIT };
  if (!isUuid(id)) return { ok: false, message: NOT_FOUND };
  return db.transaction(async (tx): Promise<PageChangeResult> => {
    const [row] = await tx.select().from(siteDocuments).where(and(isPage, isNotNull(siteDocuments.deletedAt), eq(siteDocuments.id, id))).for("update").limit(1);
    if (!row) return { ok: false, message: "That page is not in the trash." };
    const slug = await freeSlug(tx, row.slug);
    await tx.update(siteDocuments).set({ deletedAt: null, slug }).where(eq(siteDocuments.id, row.id));
    return { ok: true, path: pagePath(slug) };
  });
}

/**
 * Remove from the trash, for good, the pages that have been in it longer than
 * `TRASH_DAYS`. Their versions go with them. A page the website was built
 * with stays: removed, it would be put back by `ensureBuiltInPages`. Run by
 * the scheduled task.
 */
export async function emptyOldTrash(db: DbLike, now: Date): Promise<number> {
  const before = new Date(now.getTime() - TRASH_DAYS * 24 * 60 * 60 * 1000);
  const gone = await db
    .delete(siteDocuments)
    .where(and(isPage, isNotNull(siteDocuments.deletedAt), lt(siteDocuments.deletedAt, before), isNull(siteDocuments.builtIn)))
    .returning({ id: siteDocuments.id });
  return gone.length;
}

/**
 * Put into the database, published, each page the website was built with
 * that it has never had, with that first version in its history. A page it
 * had once is left as the owners left it, changed, moved or deleted; and an
 * address one of their own pages has stays theirs. Run when the local
 * database opens, and by `npm run db:migrate` for a database server.
 * Answers how many pages it added.
 */
export async function ensureBuiltInPages(db: Db, now: Date): Promise<number> {
  const had = new Set(
    (await db.select({ key: siteDocuments.builtIn }).from(siteDocuments).where(isNotNull(siteDocuments.builtIn))).map((row) => row.key),
  );
  let added = 0;
  for (const page of builtInPages()) {
    if (had.has(page.key)) continue;
    const content = parsePage(page.content);
    const done = await db.transaction(async (tx) => {
      if (await rowBySlug(tx, page.slug)) return false;
      const [row] = await tx
        .insert(siteDocuments)
        .values({ kind: "page", slug: page.slug, title: page.title, builtIn: page.key, published: content, publishedBy: AS_BUILT, publishedAt: now, createdAt: now })
        // Two servers starting at once: the second finds the page there and adds nothing.
        .onConflictDoNothing()
        .returning({ id: siteDocuments.id });
      if (!row) return false;
      await tx.insert(siteVersions).values({ documentId: row.id, number: 1, content, publishedBy: AS_BUILT, createdAt: now });
      return true;
    });
    if (done) added++;
  }
  return added;
}

/**
 * Where the website links to a page, in words, for a warning before the page
 * leaves it: the header, menu and footer, as published and as their draft has
 * them, and the other pages, published or not. Empty when nothing does.
 */
export async function linksToPage(db: DbLike, id: string): Promise<string[]> {
  const row = await pageRow(db, id);
  if (!row) return [];
  const path = pagePath(row.slug);
  const [published, drafted] = await together(db, [() => loadPublished(db, FRAME_DOC), () => loadDraftOrPublished(db, FRAME_DOC)]);
  const found = new Set([...frameLinksTo(published, path), ...frameLinksTo(drafted, path)]);
  const others = await db.select().from(siteDocuments).where(and(isPage, notDeleted, ne(siteDocuments.id, row.id))).orderBy(asc(siteDocuments.title));
  for (const other of others) {
    if ([other.published, other.draft].some((content) => content != null && pageLinksTo(parsePage(content), path))) found.add(`the page \u201c${other.title}\u201d`);
  }
  return [...found];
}

// ── Old addresses ────────────────────────────────────────────────────────────

/** Where an address that is no page leads now, if anywhere. */
export async function findRedirect(db: DbLike, path: string): Promise<string | null> {
  const [row] = await db.select({ to: siteRedirects.toPath }).from(siteRedirects).where(eq(siteRedirects.fromPath, path)).limit(1);
  return row?.to ?? null;
}

export interface Redirect {
  from: string;
  to: string;
}

/** Every old address and where it leads. Null for someone who may not edit pages. */
export async function listRedirects(db: DbLike, viewer: { role: string }): Promise<Redirect[] | null> {
  if (!(await abilities(db, viewer)).edit) return null;
  const rows = await db.select().from(siteRedirects).orderBy(asc(siteRedirects.fromPath));
  return rows.map((row) => ({ from: row.fromPath, to: row.toPath }));
}

/** An old address as a path: "/Rates-1/" -> "/rates-1". Null for what is not one, or for an address the site serves itself. */
function oldPath(input: string): string | null {
  const path = `/${input.trim().toLowerCase().replace(/^\/+|\/+$/g, "")}`;
  if (path === "/" || path.length > 200 || !/^(\/[a-z0-9._~-]+)+$/.test(path)) return null;
  return RESERVED_SEGMENTS.includes(path.split("/")[1]) ? null : path;
}

/**
 * Send an old address on to where its page is now: for the addresses of the
 * website this one replaced, which other sites and search engines still name.
 */
/**
 * A host's name as the site compares it: without "www." or the dot a full
 * name may end with, and with every name of the computer itself (localhost,
 * 127.0.0.1, ::1) as one.
 */
function hostKey(hostname: string): string {
  const name = hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  return name === "localhost" || name === "[::1]" || name === "0.0.0.0" || /^127(\.\d{1,3}){3}$/.test(name) ? "localhost" : name;
}

/**
 * The page a link leads to on this site, as the public route finds it: by its
 * path alone (not what follows ? or #), and without a slash at the end, which
 * the website takes off. A web address of the site itself counts as its
 * path: one of the addresses it is known by (`own`), whatever the scheme, with
 * or without "www.". Null for a link elsewhere.
 */
function pathOf(href: string, own: readonly string[]): string | null {
  let path: string | null = href.startsWith("/") && !href.startsWith("//") ? href : null;
  if (path === null && own.length > 0) {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    const ours = own.some((origin) => {
      try {
        const site = new URL(origin);
        return hostKey(url.hostname) === hostKey(site.hostname) && url.port === site.port;
      } catch {
        return false;
      }
    });
    if (ours) path = url.pathname;
  }
  return path === null ? null : normalPath(path);
}

/** What follows a link's path: its "?query" and "#section", or nothing. */
function afterPath(href: string): string {
  const at = href.search(/[?#]/);
  return at === -1 ? "" : href.slice(at);
}

/**
 * Whether visitors sent from `from` to `to` come back round to `from`, through
 * other old addresses: the address that sends them back, or null when they
 * arrive somewhere (a page that answers, an address that leads nowhere,
 * another site). A published page answers where it is, and stops them; a
 * draft does not, so visitors are sent on.
 */
async function roundBack(db: DbLike, from: string, to: string, own: readonly string[]): Promise<{ via: string } | null> {
  const start = normalPath(from);
  let via = start;
  for (let at = pathOf(to, own), steps = 0; at !== null && steps < 50; steps++) {
    if (at === start) return { via };
    if ((await rowBySlug(db, at.slice(1)))?.published != null) return null;
    const onward = await findRedirect(db, at);
    via = at;
    at = onward === null ? null : pathOf(onward, own);
  }
  return null;
}

/**
 * A path as a browser asks for it and the website reads it: "." and ".."
 * resolved (also when written %2e), escapes such as %2D decoded, and no
 * slash at the end. Two addresses that are the same page compare equal.
 */
function normalPath(path: string): string {
  let resolved = path.split(/[?#]/)[0];
  try {
    resolved = new URL(resolved, "http://site.invalid").pathname;
  } catch {
    // Left as it was typed.
  }
  const decoded = resolved
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
  return decoded.replace(/\/+$/, "") || "/";
}

/**
 * `own` are the addresses the website is known by ("https://...":
 * `siteOrigins`), so that a full address of the site is known for what it is.
 */
export async function addRedirect(
  db: Db,
  viewer: AuthUser,
  input: { from: string; to: string },
  own: readonly string[] = [],
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!(await abilities(db, viewer)).publish) return { ok: false, message: CANNOT_PUBLISH };
  const from = oldPath(input.from);
  if (!from) return { ok: false, message: "Give the old address as it comes after the site's name: /old-page." };
  const to = parseHref(input.to);
  if (!to || to.startsWith("mailto:") || to.startsWith("tel:")) return { ok: false, message: "Give where it should lead: a page of this site (/rates) or a web address (https://...)." };
  const fromPath = normalPath(from);
  if (pathOf(to, own) === fromPath) return { ok: false, message: "An address cannot lead to itself." };
  if (await rowBySlug(db, from.slice(1))) return { ok: false, message: `${from} is the address of a page here. A page's own address cannot lead elsewhere.` };
  // Nor back to itself through other old addresses: a visitor's browser would go round until it gave up.
  const back = await roundBack(db, fromPath, to, own);
  if (back) return { ok: false, message: `That would send visitors round in a circle: ${back.via} already leads back to ${from}.` };
  await db.insert(siteRedirects).values({ fromPath: from, toPath: to }).onConflictDoUpdate({ target: siteRedirects.fromPath, set: { toPath: to } });
  return { ok: true };
}

export async function removeRedirect(db: Db, viewer: AuthUser, from: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!(await abilities(db, viewer)).publish) return { ok: false, message: CANNOT_PUBLISH };
  await db.delete(siteRedirects).where(eq(siteRedirects.fromPath, from));
  return { ok: true };
}

/** A count for the Website overview: how many pages there are, and how many have changes waiting or are not published. */
export async function pageCounts(db: DbLike): Promise<{ all: number; waiting: number }> {
  const [row] = await db
    .select({ all: sql<number>`count(*)::int`, waiting: sql<number>`count(*) filter (where ${siteDocuments.draft} is not null)::int` })
    .from(siteDocuments)
    .where(and(isPage, notDeleted));
  return { all: row?.all ?? 0, waiting: row?.waiting ?? 0 };
}
