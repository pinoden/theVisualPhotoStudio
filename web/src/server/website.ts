import { and, desc, eq, isNull, max } from "drizzle-orm";
import { siteDocuments, siteVersions } from "@/db/schema";
import type { Db, DbLike } from "@/db/client";
import { can, type Ability } from "@/lib/abilities";
import { DEFAULT_DESIGN, parseDesign, type Design } from "@/lib/site/design";
import type { CustomFont } from "@/lib/site/fonts";
import { DEFAULT_FRAME, parseFrame, type Business, type SiteFrame } from "@/lib/site/frame";
import type { AuthUser } from "./auth";
import { loadCustomFonts } from "./fonts";
import { loadSettings } from "./settings";

/**
 * The website's content, with drafts, publishing and a history of versions.
 *
 * A document is something the owners edit as a whole: the design, or the
 * frame around every page (header, menu, footer). It has a published copy,
 * which is what the public sees, and while someone is working on it a draft
 * that only the admin sees. Nothing reaches the public until it is published.
 *
 *  - `saveDraft` stores a change as the draft. A draft that is the same as
 *    what is published is no draft, so "unpublished changes" is always true.
 *  - `publishDraft` makes the draft public and keeps a full copy of it in
 *    `site_versions`.
 *  - `discardDraft` throws the draft away.
 *  - `restoreVersion` copies an earlier version into the draft. Nothing is
 *    lost: the owner looks at it, then publishes it or discards it.
 *
 * What is stored is never trusted: every read goes through the document's
 * `parse`, which gives a complete, valid value whatever is in the table, so a
 * document written by an older version of the site still loads.
 *
 * Prices, opening hours, booking rules and money terms are not documents.
 * They take effect at once, as before: a draft could otherwise leave a price
 * or a term different from what customers are told.
 *
 * Every function that changes something checks the viewer itself. After a
 * publish the caller refreshes the cached pages (`updateTag(WEBSITE_TAG)`).
 */

export interface DocumentSpec<T, C = undefined> {
  kind: "design" | "frame";
  /** What it is called in a sentence: "the design". */
  name: string;
  /**
   * What reading the document depends on besides its own content, loaded once
   * for each call: for the design, the fonts the owners uploaded.
   */
  context?: (db: DbLike) => Promise<C>;
  /** A complete, valid value from whatever was stored or sent. */
  parse(input: unknown, context: C): T;
  /** What the site shows while nothing was ever published: the site as it was built. */
  original: T;
  /** What someone needs to be allowed to change it. Publishing needs `publishWebsite` as well. */
  ability: Ability;
}

export const DESIGN_DOC: DocumentSpec<Design, CustomFont[]> = {
  kind: "design",
  name: "the design",
  context: loadCustomFonts,
  parse: parseDesign,
  original: DEFAULT_DESIGN,
  ability: "editDesign",
};

export const FRAME_DOC: DocumentSpec<SiteFrame> = {
  kind: "frame",
  name: "the header, menu and footer",
  parse: parseFrame,
  original: DEFAULT_FRAME,
  ability: "editDesign",
};

/** What a document's `parse` needs besides the content. */
const contextOf = async <T, C>(db: DbLike, spec: DocumentSpec<T, C>): Promise<C> => (spec.context ? spec.context(db) : (undefined as C));

type Row = typeof siteDocuments.$inferSelect;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function rowOf<T, C>(db: DbLike, spec: DocumentSpec<T, C>): Promise<Row | null> {
  const [row] = await db
    .select()
    .from(siteDocuments)
    .where(and(eq(siteDocuments.kind, spec.kind), eq(siteDocuments.slug, ""), isNull(siteDocuments.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** The document's row, made if it was never saved, and locked until the transaction ends. */
async function rowForUpdate<T, C>(tx: DbLike, spec: DocumentSpec<T, C>): Promise<Row> {
  await tx.insert(siteDocuments).values({ kind: spec.kind, slug: "" }).onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(siteDocuments)
    .where(and(eq(siteDocuments.kind, spec.kind), eq(siteDocuments.slug, ""), isNull(siteDocuments.deletedAt)))
    .for("update")
    .limit(1);
  return row;
}

const publishedOf = <T, C>(row: Row | null, spec: DocumentSpec<T, C>, context: C): T =>
  row?.published != null ? spec.parse(row.published, context) : spec.original;

/** What the public sees. */
export async function loadPublished<T, C>(db: DbLike, spec: DocumentSpec<T, C>): Promise<T> {
  return publishedOf(await rowOf(db, spec), spec, await contextOf(db, spec));
}

/** The studio's published name and contact details, for what is not a page: an email, a receipt, a PDF file. */
export async function loadBusiness(db: DbLike): Promise<Business> {
  return (await loadPublished(db, FRAME_DOC)).business;
}

/** What a preview shows: the draft when there is one, otherwise what is published. */
export async function loadDraftOrPublished<T, C>(db: DbLike, spec: DocumentSpec<T, C>): Promise<T> {
  const [row, context] = [await rowOf(db, spec), await contextOf(db, spec)];
  return row?.draft != null ? spec.parse(row.draft, context) : publishedOf(row, spec, context);
}

/** What the viewer may do with the website, as the owners have set the switches. */
export async function websiteAbilities(db: DbLike, viewer: { role: string }): Promise<{ editDesign: boolean; editPages: boolean; publish: boolean }> {
  const settings = await loadSettings(db);
  return { editDesign: can(viewer, "editDesign", settings), editPages: can(viewer, "editPages", settings), publish: can(viewer, "publishWebsite", settings) };
}

export interface EditingState<T> {
  /** What the editor opens with: the draft when there is one, otherwise what is published. */
  content: T;
  /** What the public sees now. */
  published: T;
  /** The site as it was built, to start again from. */
  original: T;
  /** True while there are changes the public cannot see yet. */
  hasDraft: boolean;
  /** Sent back with every save, so a change made by someone else in the meantime is noticed. */
  revision: number;
  draftBy: string | null;
  draftAt: string | null;
  publishedBy: string | null;
  publishedAt: string | null;
  may: { publish: boolean };
}

/** A document as its editor needs it. Null for someone who may not change it. */
export async function loadForEditing<T, C>(db: DbLike, viewer: AuthUser, spec: DocumentSpec<T, C>): Promise<EditingState<T> | null> {
  const settings = await loadSettings(db);
  if (!can(viewer, spec.ability, settings)) return null;
  const [row, context] = [await rowOf(db, spec), await contextOf(db, spec)];
  const published = publishedOf(row, spec, context);
  return {
    content: row?.draft != null ? spec.parse(row.draft, context) : published,
    published,
    original: spec.original,
    hasDraft: row?.draft != null,
    revision: row?.draftRevision ?? 0,
    draftBy: row?.draftBy ?? null,
    draftAt: row?.draftAt?.toISOString() ?? null,
    publishedBy: row?.publishedBy ?? null,
    publishedAt: row?.publishedAt?.toISOString() ?? null,
    may: { publish: can(viewer, "publishWebsite", settings) },
  };
}

export type SaveDraftResult<T> =
  | { ok: true; revision: number; hasDraft: boolean; /** The content as it was stored: cut and corrected where needed. */ content: T; savedAt: string }
  | { ok: false; reason: "forbidden"; message: string }
  | { ok: false; reason: "conflict"; message: string; by: string | null; at: string | null };

/**
 * Store `content` as the draft. `basedOn` is the revision the editor loaded:
 * when the draft has changed since (someone else is editing, or the same
 * person in a second window), nothing is stored and the answer says who, so
 * that nobody's work is overwritten without their knowing. `force` stores it
 * anyway.
 */
export async function saveDraft<T, C>(
  db: Db,
  viewer: AuthUser,
  spec: DocumentSpec<T, C>,
  input: unknown,
  options: { basedOn: number; force?: boolean; now: Date },
): Promise<SaveDraftResult<T>> {
  if (!can(viewer, spec.ability, await loadSettings(db))) {
    return { ok: false, reason: "forbidden", message: `You cannot change ${spec.name}.` };
  }
  const context = await contextOf(db, spec);
  const content = spec.parse(input, context);
  return db.transaction(async (tx): Promise<SaveDraftResult<T>> => {
    const row = await rowForUpdate(tx, spec);
    if (!options.force && row.draftRevision !== options.basedOn) {
      return {
        ok: false,
        reason: "conflict",
        message: "This was changed somewhere else since you opened it.",
        by: row.draftBy ?? row.publishedBy,
        at: (row.draftAt ?? row.publishedAt)?.toISOString() ?? null,
      };
    }
    const hasDraft = !same(content, publishedOf(row, spec, context));
    // Saving what is already stored changes nothing, so it does not count as someone else's change.
    if (hasDraft ? row.draft != null && same(content, spec.parse(row.draft, context)) : row.draft == null) {
      return { ok: true, revision: row.draftRevision, hasDraft, content, savedAt: (row.draftAt ?? options.now).toISOString() };
    }
    const revision = row.draftRevision + 1;
    await tx
      .update(siteDocuments)
      .set({
        draft: hasDraft ? content : null,
        draftRevision: revision,
        draftBy: hasDraft ? viewer.email : null,
        draftAt: hasDraft ? options.now : null,
      })
      .where(eq(siteDocuments.id, row.id));
    return { ok: true, revision, hasDraft, content, savedAt: options.now.toISOString() };
  });
}

export type PublishResult = { ok: true; version: number } | { ok: false; message: string };

/** Make the draft public, and keep a copy of it as a version. */
export async function publishDraft<T, C>(db: Db, viewer: AuthUser, spec: DocumentSpec<T, C>, now: Date): Promise<PublishResult> {
  const settings = await loadSettings(db);
  if (!can(viewer, spec.ability, settings) || !can(viewer, "publishWebsite", settings)) {
    return { ok: false, message: "You cannot publish changes to the website. An owner can." };
  }
  const context = await contextOf(db, spec);
  return db.transaction(async (tx): Promise<PublishResult> => {
    const row = await rowForUpdate(tx, spec);
    if (row.draft == null) return { ok: false, message: "There is nothing to publish: the website already shows this." };
    const content = spec.parse(row.draft, context);
    const [last] = await tx.select({ number: max(siteVersions.number) }).from(siteVersions).where(eq(siteVersions.documentId, row.id));
    const version = (last?.number ?? 0) + 1;
    await tx.insert(siteVersions).values({ documentId: row.id, number: version, content, publishedBy: viewer.email, createdAt: now });
    await tx
      .update(siteDocuments)
      .set({
        published: content,
        publishedBy: viewer.email,
        publishedAt: now,
        draft: null,
        draftBy: null,
        draftAt: null,
        draftRevision: row.draftRevision + 1,
      })
      .where(eq(siteDocuments.id, row.id));
    return { ok: true, version };
  });
}

/**
 * Throw the draft away. The website and its history are not touched. The
 * revision moves on even when no draft was stored, so that an editor starts
 * again from what is published, without a change it had not saved yet.
 */
export async function discardDraft<T, C>(db: Db, viewer: AuthUser, spec: DocumentSpec<T, C>): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!can(viewer, spec.ability, await loadSettings(db))) return { ok: false, message: `You cannot change ${spec.name}.` };
  return db.transaction(async (tx) => {
    const row = await rowForUpdate(tx, spec);
    await tx
      .update(siteDocuments)
      .set({ draft: null, draftBy: null, draftAt: null, draftRevision: row.draftRevision + 1 })
      .where(eq(siteDocuments.id, row.id));
    return { ok: true as const };
  });
}

export interface VersionSummary {
  id: string;
  number: number;
  publishedBy: string;
  publishedAt: string;
  /** True for the version the public sees now. */
  current: boolean;
}

/** The versions that were published, newest first. Null for someone who may not change the document. */
export async function listVersions<T, C>(db: DbLike, viewer: AuthUser, spec: DocumentSpec<T, C>, limit = 30): Promise<VersionSummary[] | null> {
  if (!can(viewer, spec.ability, await loadSettings(db))) return null;
  const [row, context] = [await rowOf(db, spec), await contextOf(db, spec)];
  if (!row) return [];
  const versions = await db
    .select()
    .from(siteVersions)
    .where(eq(siteVersions.documentId, row.id))
    .orderBy(desc(siteVersions.number))
    .limit(Math.min(Math.max(limit, 1), 200));
  // The newest version whose content is what is published: an older one that happens to be equal is not "current".
  const published = publishedOf(row, spec, context);
  const currentId = row.published != null ? versions.find((version) => same(spec.parse(version.content, context), published))?.id : undefined;
  return versions.map((version) => ({
    id: version.id,
    number: version.number,
    publishedBy: version.publishedBy,
    publishedAt: version.createdAt.toISOString(),
    current: version.id === currentId,
  }));
}

export type RestoreResult = { ok: true; number: number; hasDraft: boolean } | { ok: false; message: string };

/**
 * Bring an earlier version back as the draft. The public still sees what is
 * published until the draft is published; a draft that was there is replaced.
 */
export async function restoreVersion<T, C>(db: Db, viewer: AuthUser, spec: DocumentSpec<T, C>, versionId: string, now: Date): Promise<RestoreResult> {
  if (!can(viewer, spec.ability, await loadSettings(db))) return { ok: false, message: `You cannot change ${spec.name}.` };
  if (!/^[0-9a-f-]{36}$/i.test(versionId)) return { ok: false, message: "That version was not found." };
  const context = await contextOf(db, spec);
  return db.transaction(async (tx): Promise<RestoreResult> => {
    const row = await rowForUpdate(tx, spec);
    const [version] = await tx
      .select()
      .from(siteVersions)
      .where(and(eq(siteVersions.id, versionId), eq(siteVersions.documentId, row.id)))
      .limit(1);
    if (!version) return { ok: false, message: "That version was not found." };
    const content = spec.parse(version.content, context);
    const hasDraft = !same(content, publishedOf(row, spec, context));
    await tx
      .update(siteDocuments)
      .set({
        draft: hasDraft ? content : null,
        draftBy: hasDraft ? viewer.email : null,
        draftAt: hasDraft ? now : null,
        draftRevision: row.draftRevision + 1,
      })
      .where(eq(siteDocuments.id, row.id));
    return { ok: true, number: version.number, hasDraft };
  });
}
