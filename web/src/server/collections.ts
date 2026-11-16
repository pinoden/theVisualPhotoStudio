import { and, asc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import { media, mediaCollectionItems, mediaCollections, siteDocuments } from "@/db/schema";
import type { Db, DbLike } from "@/db/client";
import { can } from "@/lib/abilities";
import type { AuthUser } from "./auth";
import { loadPictures, type Picture } from "./media";
import { loadSettings } from "./settings";
import { formatDay, localToUtc } from "./tz";

/**
 * Collections of the media library: a named set of pictures in an order the
 * owners choose. A season's sets, a studio's decor, the pictures of one
 * gallery. A collection can have a first and a last day: outside them it
 * shows nothing, so a Christmas gallery appears and goes by itself.
 *
 * Like the library, collections have no drafts: a change shows at once
 * wherever the collection is shown.
 */

export const COLLECTION_LIMITS = { name: 60, description: 300, pictures: 200 } as const;

export interface CollectionSummary {
  id: string;
  name: string;
  description: string;
  /** "2026-12-01", or null for no limit. */
  startsOn: string | null;
  endsOn: string | null;
  count: number;
  /** The first picture, to recognise the collection by. */
  cover: Picture | null;
}

export interface Collection extends Omit<CollectionSummary, "count" | "cover"> {
  pictures: Picture[];
}

const isUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const oneLine = (value: string, limit: number) => value.replace(/\s+/g, " ").trim().slice(0, limit).trim();

/** A date typed into a form: "2026-12-01", or null when empty. `undefined` for something that is not a date. */
function parseDay(value: string): string | null | undefined {
  const text = value.trim();
  if (text === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const day = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== text ? undefined : text;
}

/** Whether a collection shows on `today`, a date on the studio's clock. */
export function collectionShows(collection: { startsOn: string | null; endsOn: string | null }, today: string): boolean {
  return (collection.startsOn === null || today >= collection.startsOn) && (collection.endsOn === null || today <= collection.endsOn);
}

/** When a collection shows, in words for the admin: "Shown from Dec 1, 2026 to Dec 24, 2026: showing now." */
export function showsInWords(collection: { startsOn: string | null; endsOn: string | null }, today: string): string {
  const { startsOn, endsOn } = collection;
  if (!startsOn && !endsOn) return "Shown all year.";
  const day = (date: string) => formatDay(localToUtc(date, 12 * 60));
  const span = startsOn && endsOn ? `from ${day(startsOn)} to ${day(endsOn)}` : startsOn ? `from ${day(startsOn)}` : `until ${day(endsOn!)}`;
  return `Shown ${span}: ${collectionShows(collection, today) ? "showing now" : "not showing now"}.`;
}

async function mayEdit(db: DbLike, viewer: { role: string }): Promise<boolean> {
  return can(viewer, "editDesign", await loadSettings(db));
}

async function picturesOf(db: DbLike, collectionId: string): Promise<Picture[]> {
  const items = await db
    .select({ mediaId: mediaCollectionItems.mediaId })
    .from(mediaCollectionItems)
    .where(eq(mediaCollectionItems.collectionId, collectionId))
    .orderBy(asc(mediaCollectionItems.position), asc(mediaCollectionItems.mediaId));
  const pictures = await loadPictures(
    db,
    items.map((item) => item.mediaId),
  );
  return items.map((item) => pictures.get(item.mediaId)).filter((picture): picture is Picture => picture !== undefined);
}

/** Every collection, by name. Null for someone who may not change the website. */
export async function listCollections(db: DbLike, viewer: { role: string }): Promise<CollectionSummary[] | null> {
  if (!(await mayEdit(db, viewer))) return null;
  const rows = await db.select().from(mediaCollections).orderBy(asc(mediaCollections.name), asc(mediaCollections.id));
  return Promise.all(
    rows.map(async (row) => {
      const pictures = await picturesOf(db, row.id);
      return { id: row.id, name: row.name, description: row.description, startsOn: row.startsOn, endsOn: row.endsOn, count: pictures.length, cover: pictures[0] ?? null };
    }),
  );
}

/** One collection with its pictures in order, for whatever shows it. Null when there is none. Not a secret: no viewer is asked for. */
export async function loadCollection(db: DbLike, id: string): Promise<Collection | null> {
  if (!isUuid(id)) return null;
  const [row] = await db.select().from(mediaCollections).where(eq(mediaCollections.id, id)).limit(1);
  if (!row) return null;
  return { id: row.id, name: row.name, description: row.description, startsOn: row.startsOn, endsOn: row.endsOn, pictures: await picturesOf(db, row.id) };
}

export type CollectionResult = { ok: true; id: string } | { ok: false; message: string };

const CANNOT = "You cannot change the website's pictures.";
const NOT_FOUND = "That collection was not found.";

export async function createCollection(db: Db, viewer: AuthUser, name: string): Promise<CollectionResult> {
  if (!(await mayEdit(db, viewer))) return { ok: false, message: CANNOT };
  const clean = oneLine(name, COLLECTION_LIMITS.name);
  if (!clean) return { ok: false, message: "Give the collection a name." };
  const [row] = await db.insert(mediaCollections).values({ name: clean }).returning({ id: mediaCollections.id });
  return { ok: true, id: row.id };
}

export async function saveCollection(
  db: Db,
  viewer: AuthUser,
  id: string,
  input: { name: string; description: string; startsOn: string; endsOn: string },
): Promise<CollectionResult> {
  if (!(await mayEdit(db, viewer))) return { ok: false, message: CANNOT };
  if (!isUuid(id)) return { ok: false, message: NOT_FOUND };
  const name = oneLine(input.name, COLLECTION_LIMITS.name);
  if (!name) return { ok: false, message: "Give the collection a name." };
  const startsOn = parseDay(input.startsOn);
  const endsOn = parseDay(input.endsOn);
  if (startsOn === undefined || endsOn === undefined) return { ok: false, message: "Choose valid dates, or leave them empty." };
  if (startsOn && endsOn && endsOn < startsOn) return { ok: false, message: "The last day is before the first day." };
  const updated = await db
    .update(mediaCollections)
    .set({ name, description: oneLine(input.description, COLLECTION_LIMITS.description), startsOn, endsOn })
    .where(eq(mediaCollections.id, id))
    .returning({ id: mediaCollections.id });
  return updated.length > 0 ? { ok: true, id } : { ok: false, message: NOT_FOUND };
}

/** Delete a collection. Its pictures stay in the library. A collection that a page shows is kept, and the answer says so. */
export async function deleteCollection(db: Db, viewer: AuthUser, id: string): Promise<CollectionResult> {
  if (!(await mayEdit(db, viewer))) return { ok: false, message: CANNOT };
  if (!isUuid(id)) return { ok: false, message: NOT_FOUND };
  const shownOn = await db
    .select({ title: siteDocuments.title })
    .from(siteDocuments)
    .where(and(isNull(siteDocuments.deletedAt), sql`(coalesce(${siteDocuments.draft}::text, '') || coalesce(${siteDocuments.published}::text, '')) like ${`%${id}%`}`));
  if (shownOn.length > 0) {
    return { ok: false, message: `This collection is shown on ${shownOn.map((page) => page.title || "a page").join(", ")}. Take it off there first.` };
  }
  const deleted = await db.delete(mediaCollections).where(eq(mediaCollections.id, id)).returning({ id: mediaCollections.id });
  return deleted.length > 0 ? { ok: true, id } : { ok: false, message: NOT_FOUND };
}

/** Add pictures at the end of a collection. One that is already in it stays where it is. */
export async function addToCollection(db: Db, viewer: AuthUser, id: string, mediaIds: string[]): Promise<CollectionResult> {
  if (!(await mayEdit(db, viewer))) return { ok: false, message: CANNOT };
  const wanted = [...new Set(mediaIds.filter(isUuid))];
  if (!isUuid(id)) return { ok: false, message: NOT_FOUND };
  if (wanted.length === 0) return { ok: false, message: "Choose at least one picture." };
  return db.transaction(async (tx): Promise<CollectionResult> => {
    const [collection] = await tx.select({ id: mediaCollections.id }).from(mediaCollections).where(eq(mediaCollections.id, id)).for("update").limit(1);
    if (!collection) return { ok: false, message: NOT_FOUND };
    const existing = await tx.select({ id: media.id }).from(media).where(inArray(media.id, wanted));
    const known = new Set(existing.map((row) => row.id));
    const [last] = await tx
      .select({ position: max(mediaCollectionItems.position), count: sql<number>`count(*)::int` })
      .from(mediaCollectionItems)
      .where(eq(mediaCollectionItems.collectionId, id));
    const toAdd = wanted.filter((mediaId) => known.has(mediaId));
    if ((last?.count ?? 0) + toAdd.length > COLLECTION_LIMITS.pictures) {
      return { ok: false, message: `A collection holds ${COLLECTION_LIMITS.pictures} pictures at most.` };
    }
    let position = (last?.position ?? -1) + 1;
    for (const mediaId of toAdd) {
      await tx.insert(mediaCollectionItems).values({ collectionId: id, mediaId, position: position++ }).onConflictDoNothing();
    }
    return { ok: true, id };
  });
}

export async function removeFromCollection(db: Db, viewer: AuthUser, id: string, mediaId: string): Promise<CollectionResult> {
  if (!(await mayEdit(db, viewer))) return { ok: false, message: CANNOT };
  if (!isUuid(id) || !isUuid(mediaId)) return { ok: false, message: NOT_FOUND };
  await db.delete(mediaCollectionItems).where(and(eq(mediaCollectionItems.collectionId, id), eq(mediaCollectionItems.mediaId, mediaId)));
  return { ok: true, id };
}

/** Move a picture one place towards the start (`by` -1) or the end (1) of its collection. */
export async function moveInCollection(db: Db, viewer: AuthUser, id: string, mediaId: string, by: -1 | 1): Promise<CollectionResult> {
  if (!(await mayEdit(db, viewer))) return { ok: false, message: CANNOT };
  if (!isUuid(id) || !isUuid(mediaId)) return { ok: false, message: NOT_FOUND };
  return db.transaction(async (tx): Promise<CollectionResult> => {
    const items = await tx
      .select({ mediaId: mediaCollectionItems.mediaId })
      .from(mediaCollectionItems)
      .where(eq(mediaCollectionItems.collectionId, id))
      .orderBy(asc(mediaCollectionItems.position), asc(mediaCollectionItems.mediaId))
      .for("update");
    const order = items.map((item) => item.mediaId);
    const from = order.indexOf(mediaId);
    const to = from + by;
    if (from === -1) return { ok: false, message: "That picture is not in the collection." };
    if (to >= 0 && to < order.length) [order[from], order[to]] = [order[to], order[from]];
    // Every place is written again, so the order is whole numbers from 0 whatever it was before.
    for (const [position, entry] of order.entries()) {
      await tx
        .update(mediaCollectionItems)
        .set({ position })
        .where(and(eq(mediaCollectionItems.collectionId, id), eq(mediaCollectionItems.mediaId, entry)));
    }
    return { ok: true, id };
  });
}
