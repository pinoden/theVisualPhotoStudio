import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { siteDocuments, videos } from "@/db/schema";
import type { Db, DbLike } from "@/db/client";
import type { AuthUser } from "./auth";
import { fileStore } from "./files";
import { mayUseMediaLibrary, safeFilename } from "./media";
import { DATABASE_VIDEO_MAX_BYTES, videoStore } from "./video-store";

/**
 * The video files of the media library (the owners' note 7 of 2026-11-22, "let's start with files", and "Set up neon",
 * 2026-11-23; question 77 in ProjectLibrary.md). An upload is three steps, as a file larger than one request to the site
 * goes straight from the browser to the storage: `startVideoUpload` gives the upload address, the browser sends the file
 * there, and `finishVideoUpload` checks that it arrived whole. A page's Video block then plays it by its address on the
 * site, `/videos/<id>`, as it plays a YouTube, Vimeo or Instagram address. Whoever may use the media library may do this.
 */

/** What the site takes, by its type, and the ending its name gets. */
const VIDEO_TYPES: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };
/** At most 500 MB a file, in Neon's storage. */
const VIDEO_MAX_BYTES = 500 * 1024 * 1024;
export const VIDEO_TITLE_MAX = 120;

const videoAddress = (id: string) => `/videos/${id}`;

const isUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const NOT_ALLOWED = "You cannot add videos to the website.";
const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

export type StartResult = { ok: true; id: string; upload: { url: string; method: "PUT"; headers: Record<string, string> } } | { ok: false; message: string };

export async function startVideoUpload(db: DbLike, viewer: AuthUser, input: { filename: string; contentType: string; size: number }, now: Date): Promise<StartResult> {
  if (!(await mayUseMediaLibrary(db, viewer))) return { ok: false, message: NOT_ALLOWED };
  const ext = VIDEO_TYPES[input.contentType];
  if (!ext) return { ok: false, message: "That is not a video the site takes: an MP4, a MOV or a WebM file." };
  const store = videoStore(db);
  const most = store.kind === "neon" ? VIDEO_MAX_BYTES : DATABASE_VIDEO_MAX_BYTES;
  if (!Number.isInteger(input.size) || input.size <= 0) return { ok: false, message: "That file is empty." };
  if (input.size > most) return { ok: false, message: `That video is too large: ${mb(most)} at most.` };
  const id = randomUUID();
  const filename = safeFilename(input.filename, ext).replace(/^picture\./, "video.");
  const key = `${id}/${filename}`;
  await db.insert(videos).values({ id, storageKey: key, filename, contentType: input.contentType, size: input.size, uploadedBy: viewer.email, createdAt: now });
  return { ok: true, id, upload: await store.uploadAddress({ id, key, contentType: input.contentType }) };
}

/** Where none of Neon's storage is set up: the browser's upload, sent to the site itself, kept in the database. */
export async function receiveDatabaseUpload(db: DbLike, viewer: AuthUser, id: string, bytes: Uint8Array): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!(await mayUseMediaLibrary(db, viewer))) return { ok: false, message: NOT_ALLOWED };
  if (videoStore(db).kind !== "database" || !isUuid(id)) return { ok: false, message: "That upload was not found." };
  const [row] = await db.select().from(videos).where(and(eq(videos.id, id), eq(videos.status, "uploading"))).limit(1);
  if (!row) return { ok: false, message: "That upload was not found." };
  if (bytes.byteLength !== row.size) return { ok: false, message: "The video did not arrive whole. Please try again." };
  await fileStore(db).put(row.storageKey, bytes, row.contentType);
  return { ok: true };
}

/** The upload is checked whole (its size as announced) and the video becomes ready; one that did not arrive is dropped. */
export async function finishVideoUpload(db: DbLike, viewer: AuthUser, id: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!(await mayUseMediaLibrary(db, viewer))) return { ok: false, message: NOT_ALLOWED };
  if (!isUuid(id)) return { ok: false, message: "That upload was not found." };
  const [row] = await db.select().from(videos).where(eq(videos.id, id)).limit(1);
  if (!row) return { ok: false, message: "That upload was not found." };
  if (row.status === "ready") return { ok: true };
  const store = videoStore(db);
  const size = await store.sizeOf(row.storageKey);
  if (size !== row.size) {
    if (size !== null) await store.remove(row.storageKey);
    await db.delete(videos).where(eq(videos.id, row.id));
    return { ok: false, message: "The video did not arrive whole. Please try again." };
  }
  await db.update(videos).set({ status: "ready" }).where(eq(videos.id, row.id));
  return { ok: true };
}

export interface VideoItem {
  id: string;
  title: string;
  filename: string;
  size: number;
  address: string;
  createdAt: string;
  /** The pages that show it, by name. */
  shownOn: string[];
}

/** The ready videos, newest first, with the pages that show them. Null for a viewer who may not use the library. */
export async function listVideos(db: DbLike, viewer: AuthUser): Promise<VideoItem[] | null> {
  if (!(await mayUseMediaLibrary(db, viewer))) return null;
  const rows = await db.select().from(videos).where(eq(videos.status, "ready")).orderBy(desc(videos.createdAt));
  const uses = await pagesShowing(db, rows.map((row) => row.id));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    filename: row.filename,
    size: row.size,
    address: videoAddress(row.id),
    createdAt: row.createdAt.toISOString(),
    shownOn: uses.get(row.id) ?? [],
  }));
}

/** Which pages (a draft or what is published) name each video's address. */
async function pagesShowing(db: DbLike, ids: string[]): Promise<Map<string, string[]>> {
  const uses = new Map<string, string[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return uses;
  const documents = await db
    .select({ title: siteDocuments.title, text: sql<string>`coalesce(${siteDocuments.draft}::text, '') || coalesce(${siteDocuments.published}::text, '')` })
    .from(siteDocuments)
    .where(isNull(siteDocuments.deletedAt));
  for (const document of documents) for (const id of ids) if (document.text.includes(videoAddress(id))) uses.get(id)!.push(document.title || "A page");
  return uses;
}

export async function describeVideo(db: DbLike, viewer: AuthUser, id: string, title: string): Promise<boolean> {
  if (!(await mayUseMediaLibrary(db, viewer)) || !isUuid(id)) return false;
  const cleaned = title.replace(/\s+/g, " ").trim().slice(0, VIDEO_TITLE_MAX);
  const updated = await db.update(videos).set({ title: cleaned }).where(eq(videos.id, id)).returning({ id: videos.id });
  return updated.length === 1;
}

/** Delete a video and its file, unless a page shows it. */
export async function deleteVideo(db: Db, viewer: AuthUser, id: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!(await mayUseMediaLibrary(db, viewer))) return { ok: false, message: NOT_ALLOWED };
  if (!isUuid(id)) return { ok: false, message: "That video was not found." };
  const [row] = await db.select().from(videos).where(eq(videos.id, id)).limit(1);
  if (!row) return { ok: false, message: "That video was not found." };
  const shown = (await pagesShowing(db, [id])).get(id) ?? [];
  if (shown.length > 0) return { ok: false, message: `This video is shown on ${shown.join(" and ")}. Take it out there first, then delete it.` };
  await videoStore(db).remove(row.storageKey);
  await db.delete(videos).where(eq(videos.id, id));
  return { ok: true };
}

/** For `/videos/<id>`: where its file is read, or its bytes when the site keeps them. Null for one that is not ready. */
export async function videoForPlayer(db: DbLike, id: string): Promise<{ redirect: string } | { bytes: Uint8Array; contentType: string } | null> {
  if (!isUuid(id)) return null;
  const [row] = await db.select().from(videos).where(and(eq(videos.id, id), eq(videos.status, "ready"))).limit(1);
  if (!row) return null;
  const store = videoStore(db);
  const address = store.readAddress(row.storageKey);
  if (address) return { redirect: address };
  const file = await fileStore(db).get(row.storageKey);
  return file ? { bytes: file.bytes, contentType: row.contentType } : null;
}

/** From the scheduled task: an upload never finished, a day on, is dropped with whatever part of it arrived. */
export async function dropUnfinishedVideos(db: DbLike, now: Date): Promise<number> {
  const stale = await db.select().from(videos).where(and(eq(videos.status, "uploading"), lt(videos.createdAt, new Date(now.getTime() - 86_400_000))));
  const store = videoStore(db);
  for (const row of stale) {
    await store.remove(row.storageKey).catch(() => undefined);
    await db.delete(videos).where(eq(videos.id, row.id));
  }
  return stale.length;
}
