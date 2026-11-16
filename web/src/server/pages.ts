import { and, asc, desc, eq, isNotNull, isNull, lt, max, ne, sql } from "drizzle-orm";
import { media, mediaCollections, siteDocuments, siteRedirects, siteVersions } from "@/db/schema";
import type { Db, DbLike } from "@/db/client";
import { can } from "@/lib/abilities";
import type { SiteContext } from "@/lib/site/blocks/block";
import { cleanLine, parseHref } from "@/lib/site/frame";
import { liveValues } from "@/lib/site/live-values";
import { PAGE_LIMITS, pagePath, pageReferences, parsePage, parseSlug, RESERVED_SEGMENTS, slugFromTitle, type PageContent } from "@/lib/site/page";
import { paragraphs } from "@/lib/site/rich-text";
import type { AuthUser } from "./auth";
import { loadCatalog } from "./catalog";
import { collectionShows, loadCollection } from "./collections";
import { loadPictures } from "./media";
import { loadSettings } from "./settings";
import { localDateOf } from "./tz";
import { loadBusiness, type VersionSummary } from "./website";

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
  const [pictures, catalog, business] = await Promise.all([loadPictures(db, [...pictureIds]), loadCatalog(db), loadBusiness(db)]);
  const values = Object.fromEntries(liveValues(catalog, business).map((entry) => [entry.name, entry.value]));
  return { pictures: Object.fromEntries(pictures), collections, catalog, business, values };
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
}

function summary(row: Row): PageSummary {
  return {
    id: row.id,
    slug: row.slug,
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
    const slug = await freeSlug(tx, `${row.slug.slice(0, PAGE_LIMITS.slug - 10)}-copy`);
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
  };
}

export type SavePageResult =
  | { ok: true; revision: number; hasDraft: boolean; savedAt: string }
  | { ok: false; reason: "forbidden" | "missing"; message: string }
  | { ok: false; reason: "conflict"; message: string; by: string | null; at: string | null };

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
        by: row.draftBy ?? row.publishedBy,
        at: (row.draftAt ?? row.publishedAt)?.toISOString() ?? null,
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
 * published: the answer names them.
 */
export async function publishPage(db: Db, viewer: AuthUser, id: string, now: Date): Promise<PublishPageResult> {
  if (!(await abilities(db, viewer)).publish) return { ok: false, message: CANNOT_PUBLISH };
  return db.transaction(async (tx): Promise<PublishPageResult> => {
    const row = await pageRow(tx, id, true);
    if (!row) return { ok: false, message: NOT_FOUND };
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

/** Throw away the changes that are waiting on a published page. A page that was never published has nothing to go back to. */
export async function discardPageDraft(db: Db, viewer: AuthUser, id: string): Promise<PageChangeResult> {
  if (!(await abilities(db, viewer)).edit) return { ok: false, message: CANNOT_EDIT };
  return db.transaction(async (tx): Promise<PageChangeResult> => {
    const row = await pageRow(tx, id, true);
    if (!row) return { ok: false, message: NOT_FOUND };
    if (row.published == null) return { ok: false, message: "This page is not published, so there is nothing to go back to. To be rid of it, delete the page." };
    if (row.draft != null) {
      await tx.update(siteDocuments).set({ draft: null, draftBy: null, draftAt: null, draftRevision: row.draftRevision + 1 }).where(eq(siteDocuments.id, row.id));
    }
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

/** Bring an earlier version of a page back as its draft. The website shows what it showed until the draft is published. */
export async function restorePageVersion(db: Db, viewer: AuthUser, id: string, versionId: string, now: Date): Promise<{ ok: true; number: number } | { ok: false; message: string }> {
  if (!(await abilities(db, viewer)).edit) return { ok: false, message: CANNOT_EDIT };
  if (!isUuid(versionId)) return { ok: false, message: "That version was not found." };
  return db.transaction(async (tx) => {
    const row = await pageRow(tx, id, true);
    if (!row) return { ok: false as const, message: NOT_FOUND };
    const [version] = await tx.select().from(siteVersions).where(and(eq(siteVersions.id, versionId), eq(siteVersions.documentId, row.id))).limit(1);
    if (!version) return { ok: false as const, message: "That version was not found." };
    const content = parsePage(version.content);
    const hasDraft = row.published == null || !same(content, parsePage(row.published));
    await tx
      .update(siteDocuments)
      .set({ draft: hasDraft ? content : null, draftBy: hasDraft ? viewer.email : null, draftAt: hasDraft ? now : null, draftRevision: row.draftRevision + 1 })
      .where(eq(siteDocuments.id, row.id));
    return { ok: true as const, number: version.number };
  });
}

// ── A page's name and address ────────────────────────────────────────────────

/**
 * Change a page's name and address. They change at once, not through a
 * draft. When a published page gets a new address, the old one is kept
 * working: a redirect is written from it to the new one.
 */
export async function savePageSettings(db: Db, viewer: AuthUser, id: string, input: { title: string; slug: string }): Promise<PageChangeResult> {
  const may = await abilities(db, viewer);
  if (!may.edit) return { ok: false, message: CANNOT_EDIT };
  const title = cleanLine(input.title, PAGE_LIMITS.title);
  if (!title) return { ok: false, message: "Give the page a name." };
  const parsed = parseSlug(input.slug);
  if (!parsed.ok) return parsed;
  return db.transaction(async (tx): Promise<PageChangeResult> => {
    const row = await pageRow(tx, id, true);
    if (!row) return { ok: false, message: NOT_FOUND };
    const moved = parsed.slug !== row.slug;
    if (moved && row.published != null && !may.publish) return { ok: false, message: "This page is on the website, so changing its address changes the website. An owner can." };
    if (moved && (await freeSlug(tx, parsed.slug, row.id)) !== parsed.slug) return { ok: false, message: `Another page already has the address /${parsed.slug}.` };
    await tx.update(siteDocuments).set({ title, slug: parsed.slug }).where(eq(siteDocuments.id, row.id));
    if (moved) {
      const [from, to] = [pagePath(row.slug), pagePath(parsed.slug)];
      // Nothing may lead away from the address the page now has, and what led to the old address leads on to the new.
      await tx.delete(siteRedirects).where(eq(siteRedirects.fromPath, to));
      await tx.update(siteRedirects).set({ toPath: to }).where(eq(siteRedirects.toPath, from));
      if (row.published != null) {
        await tx.insert(siteRedirects).values({ fromPath: from, toPath: to }).onConflictDoUpdate({ target: siteRedirects.fromPath, set: { toPath: to } });
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

/** Remove from the trash, for good, the pages that have been in it longer than `TRASH_DAYS`. Their versions go with them. Run by the scheduled task. */
export async function emptyOldTrash(db: DbLike, now: Date): Promise<number> {
  const before = new Date(now.getTime() - TRASH_DAYS * 24 * 60 * 60 * 1000);
  const gone = await db.delete(siteDocuments).where(and(isPage, isNotNull(siteDocuments.deletedAt), lt(siteDocuments.deletedAt, before))).returning({ id: siteDocuments.id });
  return gone.length;
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
  return RESERVED_SEGMENTS.filter((segment) => !["contact", "faq", "policies", "rates", "services", "studios"].includes(segment)).includes(path.split("/")[1]) ? null : path;
}

/**
 * Send an old address on to where its page is now: for the addresses of the
 * website this one replaced, which other sites and search engines still name.
 */
export async function addRedirect(db: Db, viewer: AuthUser, input: { from: string; to: string }): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!(await abilities(db, viewer)).publish) return { ok: false, message: CANNOT_PUBLISH };
  const from = oldPath(input.from);
  if (!from) return { ok: false, message: "Give the old address as it comes after the site's name: /old-page." };
  const to = parseHref(input.to);
  if (!to || to.startsWith("mailto:") || to.startsWith("tel:")) return { ok: false, message: "Give where it should lead: a page of this site (/rates) or a web address (https://...)." };
  if (to === from) return { ok: false, message: "An address cannot lead to itself." };
  if (await rowBySlug(db, from.slice(1))) return { ok: false, message: `${from} is the address of a page here. A page's own address cannot lead elsewhere.` };
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
