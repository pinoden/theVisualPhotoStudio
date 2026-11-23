import { and, asc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import { media, photographyPhotos, siteDocuments } from "@/db/schema";
import type { Db, DbLike } from "@/db/client";
import { eachBlock } from "@/lib/site/page";
import type { StoredBlock } from "@/lib/site/blocks/fields";
import type { AuthUser } from "./auth";
import { loadPictures, type Picture } from "./media";

/**
 * The photos the site shows for photography (the owners' note 4 of 2026-11-22, and the owner's answer of 2026-11-23,
 * "let admin a chance to decide": question 73 in ProjectLibrary.md). Pictures of the media library, chosen and put in
 * order under Admin → Photography by the owners, and shown at once wherever a page has a Gallery set to them. Like the
 * studios' photos, each must say what it shows first. Each function checks the viewer itself.
 */

export const PHOTOGRAPHY_PHOTO_LIMIT = 24;

const OWNERS_ONLY = "Only an owner can change the photography photos.";
const isUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export type PhotographyPhotoResult = { ok: true } | { ok: false; message: string };

/** The photos, in the owners' order. A picture deleted from the library cannot be: it is taken off here first. */
export async function loadPhotographyPhotos(db: DbLike): Promise<Picture[]> {
  const rows = await db.select({ mediaId: photographyPhotos.mediaId }).from(photographyPhotos).orderBy(asc(photographyPhotos.position), asc(photographyPhotos.mediaId));
  const pictures = await loadPictures(
    db,
    rows.map((row) => row.mediaId),
  );
  return rows.flatMap((row) => pictures.get(row.mediaId) ?? []);
}

/** Add pictures at the end. A picture that does not say what it shows is refused, as for a studio's photos. */
export async function addPhotographyPhotos(db: Db, viewer: AuthUser, mediaIds: string[]): Promise<PhotographyPhotoResult> {
  if (viewer.role !== "owner") return { ok: false, message: OWNERS_ONLY };
  const wanted = [...new Set(mediaIds.filter(isUuid))];
  if (wanted.length === 0) return { ok: false, message: "Choose at least one picture." };
  return db.transaction(async (tx): Promise<PhotographyPhotoResult> => {
    // One change at a time: two owners adding at once would count the same places.
    await tx.execute(sql`lock table ${photographyPhotos} in share row exclusive mode`);
    const pictures = await tx.select({ id: media.id, alt: media.alt, filename: media.filename }).from(media).where(inArray(media.id, wanted));
    const undescribed = pictures.filter((picture) => picture.alt.trim() === "");
    if (undescribed.length > 0) {
      return {
        ok: false,
        message: `Say what ${undescribed.length === 1 ? `the picture ${undescribed[0].filename} shows` : `these pictures show (${undescribed.map((picture) => picture.filename).join(", ")})`} first, in the media library. Then add ${undescribed.length === 1 ? "it" : "them"} here.`,
      };
    }
    const [last] = await tx.select({ position: max(photographyPhotos.position), count: sql<number>`count(*)::int` }).from(photographyPhotos);
    const already = new Set((await tx.select({ mediaId: photographyPhotos.mediaId }).from(photographyPhotos)).map((row) => row.mediaId));
    const toAdd = wanted.filter((id) => pictures.some((picture) => picture.id === id) && !already.has(id));
    if ((last?.count ?? 0) + toAdd.length > PHOTOGRAPHY_PHOTO_LIMIT) return { ok: false, message: `Photography takes ${PHOTOGRAPHY_PHOTO_LIMIT} photos at most.` };
    let position = (last?.position ?? -1) + 1;
    for (const mediaId of toAdd) await tx.insert(photographyPhotos).values({ mediaId, position: position++ });
    return { ok: true };
  });
}

export async function removePhotographyPhoto(db: Db, viewer: AuthUser, mediaId: string): Promise<PhotographyPhotoResult> {
  if (viewer.role !== "owner") return { ok: false, message: OWNERS_ONLY };
  if (!isUuid(mediaId)) return { ok: false, message: "That photo was not found." };
  await db.delete(photographyPhotos).where(eq(photographyPhotos.mediaId, mediaId));
  return { ok: true };
}

/** Move a photo one place towards the start (`by` -1) or the end (1). */
export async function movePhotographyPhoto(db: Db, viewer: AuthUser, mediaId: string, by: -1 | 1): Promise<PhotographyPhotoResult> {
  if (viewer.role !== "owner") return { ok: false, message: OWNERS_ONLY };
  if (!isUuid(mediaId)) return { ok: false, message: "That photo was not found." };
  return db.transaction(async (tx): Promise<PhotographyPhotoResult> => {
    const rows = await tx.select({ mediaId: photographyPhotos.mediaId }).from(photographyPhotos).orderBy(asc(photographyPhotos.position), asc(photographyPhotos.mediaId)).for("update");
    const order = rows.map((row) => row.mediaId);
    const from = order.indexOf(mediaId);
    if (from === -1) return { ok: false, message: "That photo was not found." };
    const to = from + by;
    if (to >= 0 && to < order.length) [order[from], order[to]] = [order[to], order[from]];
    for (const [position, entry] of order.entries()) await tx.update(photographyPhotos).set({ position }).where(eq(photographyPhotos.mediaId, entry));
    return { ok: true };
  });
}

/** Whether these blocks hold a Gallery that shows the photography photos, at any depth. */
export function showsPhotographyPhotos(blocks: StoredBlock[]): boolean {
  let found = false;
  eachBlock(blocks, (block) => {
    if (block.type === "Gallery" && (block.props as { source?: unknown }).source === "photography") found = true;
  });
  return found;
}

/** The published pages that show the photos, by name and address, for Admin → Photography to say where they are. */
export async function pagesShowingPhotographyPhotos(db: DbLike): Promise<{ title: string; slug: string }[]> {
  const rows = await db
    .select({ title: siteDocuments.title, slug: siteDocuments.slug, published: siteDocuments.published })
    .from(siteDocuments)
    .where(and(eq(siteDocuments.kind, "page"), isNull(siteDocuments.deletedAt)))
    .orderBy(asc(siteDocuments.title));
  return rows
    .filter((row) => {
      const blocks = (row.published as { blocks?: unknown } | null)?.blocks;
      return Array.isArray(blocks) && showsPhotographyPhotos(blocks as StoredBlock[]);
    })
    .map((row) => ({ title: row.title, slug: row.slug }));
}
