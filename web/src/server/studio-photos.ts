import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import { media, studioPhotos, studios } from "@/db/schema";
import type { Db, DbLike } from "@/db/client";
import type { AuthUser } from "./auth";
import { loadPictures, type Picture } from "./media";

/**
 * The photos of each studio: pictures of the media library, in the order the
 * owners put them. The first is the one on the studio's card; all of them
 * are on the studios page. Like a studio's text they are the owners' to set,
 * and take effect at once. Each function checks the viewer itself.
 */

export const STUDIO_PHOTO_LIMIT = 12;

const isUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Every studio's photos, in order: studio id -> pictures. */
export async function loadStudioPhotos(db: DbLike): Promise<Map<string, Picture[]>> {
  const rows = await db
    .select({ studioId: studioPhotos.studioId, mediaId: studioPhotos.mediaId })
    .from(studioPhotos)
    .orderBy(asc(studioPhotos.studioId), asc(studioPhotos.position), asc(studioPhotos.mediaId));
  const pictures = await loadPictures(
    db,
    rows.map((row) => row.mediaId),
  );
  const byStudio = new Map<string, Picture[]>();
  for (const row of rows) {
    const picture = pictures.get(row.mediaId);
    if (picture) byStudio.set(row.studioId, [...(byStudio.get(row.studioId) ?? []), picture]);
  }
  return byStudio;
}

export type StudioPhotoResult = { ok: true } | { ok: false; message: string };

const OWNERS_ONLY = "Only an owner can change a studio's photos.";

/**
 * Add pictures to the end of a studio's photos. A picture has to say what it
 * shows first: a photo of a studio with no description tells nothing to
 * someone who cannot see it, or to a search engine.
 */
export async function addStudioPhotos(db: Db, viewer: AuthUser, studioId: string, mediaIds: string[]): Promise<StudioPhotoResult> {
  if (viewer.role !== "owner") return { ok: false, message: OWNERS_ONLY };
  const wanted = [...new Set(mediaIds.filter(isUuid))];
  if (!isUuid(studioId)) return { ok: false, message: "That studio was not found." };
  if (wanted.length === 0) return { ok: false, message: "Choose at least one picture." };
  return db.transaction(async (tx): Promise<StudioPhotoResult> => {
    const [studio] = await tx.select({ id: studios.id }).from(studios).where(eq(studios.id, studioId)).for("update").limit(1);
    if (!studio) return { ok: false, message: "That studio was not found." };
    const pictures = await tx.select({ id: media.id, alt: media.alt, filename: media.filename }).from(media).where(inArray(media.id, wanted));
    const undescribed = pictures.filter((picture) => picture.alt.trim() === "");
    if (undescribed.length > 0) {
      return {
        ok: false,
        message: `Say what ${undescribed.length === 1 ? `the picture ${undescribed[0].filename} shows` : `these pictures show (${undescribed.map((picture) => picture.filename).join(", ")})`} first, in the media library. Then add ${undescribed.length === 1 ? "it" : "them"} here.`,
      };
    }
    const [last] = await tx
      .select({ position: max(studioPhotos.position), count: sql<number>`count(*)::int` })
      .from(studioPhotos)
      .where(eq(studioPhotos.studioId, studioId));
    const already = new Set((await tx.select({ mediaId: studioPhotos.mediaId }).from(studioPhotos).where(eq(studioPhotos.studioId, studioId))).map((row) => row.mediaId));
    const toAdd = wanted.filter((id) => pictures.some((picture) => picture.id === id) && !already.has(id));
    if ((last?.count ?? 0) + toAdd.length > STUDIO_PHOTO_LIMIT) return { ok: false, message: `A studio takes ${STUDIO_PHOTO_LIMIT} photos at most.` };
    let position = (last?.position ?? -1) + 1;
    for (const mediaId of toAdd) await tx.insert(studioPhotos).values({ studioId, mediaId, position: position++ });
    return { ok: true };
  });
}

export async function removeStudioPhoto(db: Db, viewer: AuthUser, studioId: string, mediaId: string): Promise<StudioPhotoResult> {
  if (viewer.role !== "owner") return { ok: false, message: OWNERS_ONLY };
  if (!isUuid(studioId) || !isUuid(mediaId)) return { ok: false, message: "That photo was not found." };
  await db.delete(studioPhotos).where(and(eq(studioPhotos.studioId, studioId), eq(studioPhotos.mediaId, mediaId)));
  return { ok: true };
}

/** Move a photo one place towards the start (`by` -1) or the end (1). The first photo is the studio's main one. */
export async function moveStudioPhoto(db: Db, viewer: AuthUser, studioId: string, mediaId: string, by: -1 | 1): Promise<StudioPhotoResult> {
  if (viewer.role !== "owner") return { ok: false, message: OWNERS_ONLY };
  if (!isUuid(studioId) || !isUuid(mediaId)) return { ok: false, message: "That photo was not found." };
  return db.transaction(async (tx): Promise<StudioPhotoResult> => {
    const rows = await tx
      .select({ mediaId: studioPhotos.mediaId })
      .from(studioPhotos)
      .where(eq(studioPhotos.studioId, studioId))
      .orderBy(asc(studioPhotos.position), asc(studioPhotos.mediaId))
      .for("update");
    const order = rows.map((row) => row.mediaId);
    const from = order.indexOf(mediaId);
    const to = from + by;
    if (from === -1) return { ok: false, message: "That photo was not found." };
    if (to >= 0 && to < order.length) [order[from], order[to]] = [order[to], order[from]];
    for (const [position, entry] of order.entries()) {
      await tx
        .update(studioPhotos)
        .set({ position })
        .where(and(eq(studioPhotos.studioId, studioId), eq(studioPhotos.mediaId, entry)));
    }
    return { ok: true };
  });
}
