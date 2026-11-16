import { randomUUID } from "node:crypto";
import { asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import sharp from "sharp";
import { media, mediaCollectionItems, mediaCollections, siteDocuments, studioPhotos, studios } from "@/db/schema";
import type { Db, DbLike } from "@/db/client";
import { can } from "@/lib/abilities";
import type { AuthUser } from "./auth";
import { fileStore } from "./files";
import { loadSettings } from "./settings";

/**
 * The media library: the pictures the owners upload for the website.
 *
 * A picture is prepared once, when it arrives: turned the right way up,
 * made no larger than a screen can use, and saved again without what a
 * camera writes into a file (where and when it was taken). The framework's
 * image handling then serves each visitor a size and a format that suit
 * their screen.
 *
 * Whatever shows a picture names it by its id. Its address carries a version
 * that goes up when the file is replaced, so a replaced picture changes
 * everywhere at once and an old copy is never served from a cache.
 *
 * A picture that is shown somewhere (on a page, in the header, for a studio,
 * in a collection) cannot be deleted: `deleteMedia` says where it is used.
 *
 * Unlike a page, the library has no drafts: uploading, replacing and
 * describing a picture take effect at once. Every function that changes
 * something checks the viewer itself.
 */

export const MEDIA_LIMITS = {
  /** The largest file that is accepted. The uploader makes photographs smaller in the browser before sending them. */
  uploadBytes: 15 * 1024 * 1024,
  /** The longest side a stored picture has, in pixels. Larger ones are made smaller. */
  edge: 2560,
  /** The most pixels a picture may have when it arrives, so that a crafted file cannot exhaust the server's memory. */
  pixels: 80_000_000,
  alt: 200,
  caption: 300,
} as const;

/** The kinds of picture that are accepted, with the ending of their file. */
const FORMATS: Record<string, { ext: string; contentType: string }> = {
  jpeg: { ext: "jpg", contentType: "image/jpeg" },
  png: { ext: "png", contentType: "image/png" },
  webp: { ext: "webp", contentType: "image/webp" },
  avif: { ext: "avif", contentType: "image/avif" },
};
export const ACCEPTED_PICTURES = "JPEG, PNG, WebP or AVIF";

/** A picture as a page needs it. */
export interface Picture {
  id: string;
  url: string;
  width: number;
  height: number;
  alt: string;
  caption: string;
}

/** A picture as the library lists it. */
export interface MediaItem extends Picture {
  filename: string;
  contentType: string;
  /** In bytes. */
  size: number;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
  /** Where it is shown. Empty for a picture nothing uses. */
  uses: MediaUse[];
}

export interface MediaUse {
  where: "page" | "frame" | "studio" | "collection";
  /** What it is called there: the page's name, the studio's, the collection's. */
  name: string;
}

type Row = typeof media.$inferSelect;

/** The address of a picture: its id, its version, and its name for people and search engines. */
export function mediaUrl(row: Pick<Row, "id" | "version" | "filename">): string {
  return `/media/${row.id}/${row.version}/${row.filename}`;
}

const toPicture = (row: Row): Picture => ({ id: row.id, url: mediaUrl(row), width: row.width, height: row.height, alt: row.alt, caption: row.caption });

const isUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Who may use the library: whoever may change the website. */
async function mayEdit(db: DbLike, viewer: { role: string }): Promise<boolean> {
  return can(viewer, "editDesign", await loadSettings(db));
}

/** "IMG 0042 (final).JPG" -> "img-0042-final": a name that is safe in an address. The ending is added from what the file really is. */
export function safeFilename(name: string, ext: string): string {
  const base =
    name
      .replace(/^.*[\\/]/, "")
      .replace(/\.[A-Za-z0-9]{1,5}$/, "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "picture";
  return `${base}.${ext}`;
}

export type PreparedImage =
  | { ok: true; bytes: Uint8Array; contentType: string; ext: string; width: number; height: number }
  | { ok: false; message: string };

/**
 * A picture as it will be stored. It is read as a picture, which is also the
 * check that it is one, whatever the file was called; turned the way its
 * camera held it; made no larger than `MEDIA_LIMITS.edge`; and saved again in
 * its own format, which leaves behind everything else that was in the file.
 */
export async function prepareImage(input: Uint8Array): Promise<PreparedImage> {
  if (input.byteLength === 0) return { ok: false, message: "That file is empty." };
  if (input.byteLength > MEDIA_LIMITS.uploadBytes) {
    return { ok: false, message: `That file is too large: ${Math.round(MEDIA_LIMITS.uploadBytes / 1024 / 1024)} MB at most.` };
  }
  try {
    const source = sharp(input, { failOn: "error", limitInputPixels: MEDIA_LIMITS.pixels });
    const facts = await source.metadata();
    // AVIF arrives as "heif" with the compression "av1". A HEIC photograph is "heif" too, and cannot be read here.
    const format = facts.format === "heif" && facts.compression === "av1" ? "avif" : facts.format;
    const kind = format ? FORMATS[format] : undefined;
    if (!kind) return { ok: false, message: `That is not a picture the website can show. Use a ${ACCEPTED_PICTURES} file.` };

    const sized = source.rotate().resize({ width: MEDIA_LIMITS.edge, height: MEDIA_LIMITS.edge, fit: "inside", withoutEnlargement: true });
    const encoded =
      format === "jpeg"
        ? sized.jpeg({ quality: 88, mozjpeg: true })
        : format === "png"
          ? sized.png({ compressionLevel: 9 })
          : format === "webp"
            ? sized.webp({ quality: 88 })
            : sized.avif({ quality: 62 });
    const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
    return { ok: true, bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), contentType: kind.contentType, ext: kind.ext, width: info.width, height: info.height };
  } catch {
    return { ok: false, message: `That file could not be read as a picture. Use a ${ACCEPTED_PICTURES} file.` };
  }
}

export type MediaResult = { ok: true; picture: Picture } | { ok: false; message: string };

/** Add a picture to the library. */
export async function uploadImage(db: Db, viewer: AuthUser, input: { bytes: Uint8Array; filename: string }, now: Date): Promise<MediaResult> {
  if (!(await mayEdit(db, viewer))) return { ok: false, message: "You cannot add pictures to the website." };
  const prepared = await prepareImage(input.bytes);
  if (!prepared.ok) return prepared;
  const fileKey = `pictures/${randomUUID()}.${prepared.ext}`;
  return db.transaction(async (tx): Promise<MediaResult> => {
    await fileStore(tx).put(fileKey, prepared.bytes, prepared.contentType);
    const [row] = await tx
      .insert(media)
      .values({
        fileKey,
        filename: safeFilename(input.filename, prepared.ext),
        contentType: prepared.contentType,
        size: prepared.bytes.byteLength,
        width: prepared.width,
        height: prepared.height,
        uploadedBy: viewer.email,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return { ok: true, picture: toPicture(row) };
  });
}

/**
 * Put a new file in a picture's place. Its description stays, and so does
 * everything that shows it: they all show the new file from now on.
 */
export async function replaceImage(db: Db, viewer: AuthUser, id: string, input: { bytes: Uint8Array; filename: string }, now: Date): Promise<MediaResult> {
  if (!(await mayEdit(db, viewer))) return { ok: false, message: "You cannot change the website's pictures." };
  if (!isUuid(id)) return { ok: false, message: "That picture was not found." };
  const prepared = await prepareImage(input.bytes);
  if (!prepared.ok) return prepared;
  const fileKey = `pictures/${randomUUID()}.${prepared.ext}`;
  return db.transaction(async (tx): Promise<MediaResult> => {
    const [current] = await tx.select().from(media).where(eq(media.id, id)).for("update").limit(1);
    if (!current) return { ok: false, message: "That picture was not found." };
    const files = fileStore(tx);
    await files.put(fileKey, prepared.bytes, prepared.contentType);
    const [row] = await tx
      .update(media)
      .set({
        fileKey,
        version: current.version + 1,
        filename: safeFilename(input.filename, prepared.ext),
        contentType: prepared.contentType,
        size: prepared.bytes.byteLength,
        width: prepared.width,
        height: prepared.height,
        updatedAt: now,
      })
      .where(eq(media.id, id))
      .returning();
    await files.remove(current.fileKey);
    return { ok: true, picture: toPicture(row) };
  });
}

const oneLine = (value: string, max: number) => value.replace(/\s+/g, " ").trim().slice(0, max).trim();

/** Say what a picture shows, and what is written under it in a gallery. */
export async function describeMedia(db: Db, viewer: AuthUser, id: string, text: { alt: string; caption: string }, now: Date): Promise<MediaResult> {
  if (!(await mayEdit(db, viewer))) return { ok: false, message: "You cannot change the website's pictures." };
  if (!isUuid(id)) return { ok: false, message: "That picture was not found." };
  const [row] = await db
    .update(media)
    .set({ alt: oneLine(text.alt, MEDIA_LIMITS.alt), caption: oneLine(text.caption, MEDIA_LIMITS.caption), updatedAt: now })
    .where(eq(media.id, id))
    .returning();
  return row ? { ok: true, picture: toPicture(row) } : { ok: false, message: "That picture was not found." };
}

/**
 * Where each of these pictures is shown. A page, the header or the design
 * counts whether it shows the picture in what is published or only in a
 * draft: either way, deleting the picture would leave a hole.
 */
export async function mediaUses(db: DbLike, ids: string[]): Promise<Map<string, MediaUse[]>> {
  const uses = new Map<string, MediaUse[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return uses;
  const [ofStudios, ofCollections, documents] = await Promise.all([
    db.select({ mediaId: studioPhotos.mediaId, name: studios.name }).from(studioPhotos).innerJoin(studios, eq(studios.id, studioPhotos.studioId)).where(inArray(studioPhotos.mediaId, ids)),
    db
      .select({ mediaId: mediaCollectionItems.mediaId, name: mediaCollections.name })
      .from(mediaCollectionItems)
      .innerJoin(mediaCollections, eq(mediaCollections.id, mediaCollectionItems.collectionId))
      .where(inArray(mediaCollectionItems.mediaId, ids)),
    // Documents are few and small: each is read once as text and searched for every id.
    db
      .select({ kind: siteDocuments.kind, title: siteDocuments.title, text: sql<string>`coalesce(${siteDocuments.draft}::text, '') || coalesce(${siteDocuments.published}::text, '')` })
      .from(siteDocuments)
      .where(isNull(siteDocuments.deletedAt)),
  ]);
  for (const row of ofStudios) uses.get(row.mediaId)?.push({ where: "studio", name: row.name });
  for (const row of ofCollections) uses.get(row.mediaId)?.push({ where: "collection", name: row.name });
  for (const document of documents) {
    for (const id of ids) {
      if (!document.text.includes(id)) continue;
      uses.get(id)!.push(document.kind === "page" ? { where: "page", name: document.title || "A page" } : { where: "frame", name: "Header, menu & footer" });
    }
  }
  return uses;
}

/** "the page Studios, the studio Blanche and the collection Christmas" */
export function usesInWords(uses: MediaUse[]): string {
  const words = uses.map((use) => (use.where === "frame" ? "the header" : `the ${use.where} ${use.name}`));
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

export type DeleteMediaResult = { ok: true } | { ok: false; message: string; uses?: MediaUse[] };

/** Delete a picture that nothing shows. One that is shown somewhere is kept, and the answer says where. */
export async function deleteMedia(db: Db, viewer: AuthUser, id: string): Promise<DeleteMediaResult> {
  if (!(await mayEdit(db, viewer))) return { ok: false, message: "You cannot delete the website's pictures." };
  if (!isUuid(id)) return { ok: false, message: "That picture was not found." };
  return db.transaction(async (tx): Promise<DeleteMediaResult> => {
    const [row] = await tx.select().from(media).where(eq(media.id, id)).for("update").limit(1);
    if (!row) return { ok: false, message: "That picture was not found." };
    const uses = (await mediaUses(tx, [id])).get(id) ?? [];
    if (uses.length > 0) {
      return { ok: false, message: `This picture is shown in ${usesInWords(uses)}. Take it out there first, then delete it.`, uses };
    }
    await tx.delete(media).where(eq(media.id, id));
    await fileStore(tx).remove(row.fileKey);
    return { ok: true };
  });
}

export type MediaFilter = "all" | "undescribed" | "unused";

/**
 * The library, newest first. `q` narrows it to the pictures whose name or
 * description contains it. Null for someone who may not change the website.
 */
export async function listMedia(db: DbLike, viewer: { role: string }, options: { q?: string; filter?: MediaFilter } = {}): Promise<MediaItem[] | null> {
  if (!(await mayEdit(db, viewer))) return null;
  const rows = await db.select().from(media).orderBy(desc(media.createdAt), asc(media.id)).limit(2000);
  const uses = await mediaUses(
    db,
    rows.map((row) => row.id),
  );
  const term = (options.q ?? "").trim().toLowerCase().slice(0, 100);
  return rows
    .map((row) => ({
      ...toPicture(row),
      filename: row.filename,
      contentType: row.contentType,
      size: row.size,
      uploadedBy: row.uploadedBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      uses: uses.get(row.id) ?? [],
    }))
    .filter((item) => term === "" || `${item.filename} ${item.alt} ${item.caption}`.toLowerCase().includes(term))
    .filter((item) => (options.filter === "undescribed" ? item.alt === "" : options.filter === "unused" ? item.uses.length === 0 : true));
}

/**
 * The pictures with these ids, for whatever shows them. One that is not in
 * the library (deleted, or never there) is simply missing from the answer,
 * and whatever wanted to show it shows nothing.
 */
export async function loadPictures(db: DbLike, ids: readonly unknown[]): Promise<Map<string, Picture>> {
  const wanted = [...new Set(ids.filter(isUuid))];
  if (wanted.length === 0) return new Map();
  const rows = await db.select().from(media).where(inArray(media.id, wanted));
  return new Map(rows.map((row) => [row.id, toPicture(row)]));
}

/** The file behind a picture's address. Null when there is no such picture. */
export async function readMediaFile(db: DbLike, id: string): Promise<{ bytes: Uint8Array; contentType: string; version: number; filename: string } | null> {
  if (!isUuid(id)) return null;
  const [row] = await db.select().from(media).where(eq(media.id, id)).limit(1);
  if (!row) return null;
  const file = await fileStore(db).get(row.fileKey);
  return file ? { bytes: file.bytes, contentType: row.contentType, version: row.version, filename: row.filename } : null;
}
