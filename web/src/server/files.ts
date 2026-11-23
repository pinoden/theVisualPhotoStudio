import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { siteFiles } from "@/db/schema";
import type { DbLike } from "@/db/client";
import { neonBucket, type NeonBucket } from "./neon-storage";

/**
 * Where the files the owners upload are kept: pictures and fonts (and a video, where Neon's storage for videos is not
 * set up).
 *
 * On the host, a private bucket of Neon's storage (`FILES_BUCKET`, "site-files"; the owners' word of 2026-11-23,
 * "videos will go to neon, as well as all the photos we're using for the website"; question 78 in ProjectLibrary.md).
 * The site still serves every file at its own address (`/media/…`, `/font-files/…`), so no page changes, the host's
 * cache keeps them, and the bucket is read by the site alone. A file not found there is read from the database, where
 * every file was kept before (`site_files`): one not moved yet still shows (`scripts/move-files-to-bucket.ts` moves them).
 * Without the bucket's settings (a computer of the builder's, the tests), the files are rows of `site_files`.
 *
 * A key names one file for good: a new version of a picture is a new key. So a file, once written, never changes, and
 * can be cached for ever.
 *
 * A file is written before the row that names it, and removed only once the change that let go of it is committed
 * (`removeFiles`): a bucket is not part of a transaction, so a removal inside one that then failed would lose a file a
 * row still names. A failed change can at worst leave a file nothing names.
 */
export interface StoredFile {
  bytes: Uint8Array;
  contentType: string;
}

export interface FileStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredFile | null>;
  /** Its size in bytes, or null when it is not there. */
  sizeOf(key: string): Promise<number | null>;
  /** Removing a file that is not there is not an error. */
  remove(key: string): Promise<void>;
}

/** Files as rows of `site_files`. */
function databaseFiles(db: DbLike): FileStore {
  return {
    async put(key, bytes, contentType) {
      await db
        .insert(siteFiles)
        .values({ key, bytes, contentType, size: bytes.byteLength })
        .onConflictDoUpdate({ target: siteFiles.key, set: { bytes, contentType, size: bytes.byteLength } });
    },
    async get(key) {
      const [row] = await db.select({ bytes: siteFiles.bytes, contentType: siteFiles.contentType }).from(siteFiles).where(eq(siteFiles.key, key)).limit(1);
      return row ?? null;
    },
    async sizeOf(key) {
      const [row] = await db.select({ size: siteFiles.size }).from(siteFiles).where(eq(siteFiles.key, key)).limit(1);
      return row?.size ?? null;
    },
    async remove(key) {
      await db.delete(siteFiles).where(eq(siteFiles.key, key));
    },
  };
}

const notThere = (error: unknown) => {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
};

/** Files in a bucket of Neon's storage, with the database's rows read for what is not there yet. */
function bucketFiles(db: DbLike, { s3, bucket }: NeonBucket): FileStore {
  const before = databaseFiles(db);
  return {
    async put(key, bytes, contentType) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType, ContentLength: bytes.byteLength }));
    },
    async get(key) {
      try {
        const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const bytes = await object.Body?.transformToByteArray();
        if (bytes) return { bytes, contentType: object.ContentType ?? "application/octet-stream" };
      } catch (error) {
        if (!notThere(error)) throw error;
      }
      return before.get(key);
    },
    async sizeOf(key) {
      try {
        const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        if (head.ContentLength !== undefined) return head.ContentLength;
      } catch (error) {
        if (!notThere(error)) throw error;
      }
      return before.sizeOf(key);
    },
    async remove(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      await before.remove(key);
    },
  };
}

/** The store in use: Neon's bucket where it is set up, the database otherwise. */
export function fileStore(db: DbLike): FileStore {
  const neon = neonBucket("FILES_BUCKET");
  return neon ? bucketFiles(db, neon) : databaseFiles(db);
}

/**
 * Remove the files a committed change let go of (a replaced picture, a deleted font). Called after the transaction, never
 * inside it. One that cannot be removed now is left behind, named by nothing, and the change stands.
 */
export async function removeFiles(db: DbLike, keys: readonly string[]): Promise<void> {
  const store = fileStore(db);
  for (const key of keys) {
    try {
      await store.remove(key);
    } catch (error) {
      console.error(`A file the site no longer uses could not be removed (${key}):`, error);
    }
  }
}

export interface FileMove {
  /** The files still in the database, and their bytes. */
  waiting: { files: number; bytes: number };
  /** Moved by this run: written to the bucket, read back at their size, then deleted from the database. */
  moved: number;
}

/**
 * Move the files still kept in the database into the bucket (`scripts/move-files-to-bucket.ts`), one at a time: each is
 * written, its size in the bucket checked, and only then its row deleted. Without `apply` it only counts them. Run again,
 * it moves what is left; nothing is lost if it stops halfway, as the site reads a file from either place.
 */
export async function moveFilesToBucket(db: DbLike, { apply }: { apply: boolean }): Promise<FileMove> {
  const neon = neonBucket("FILES_BUCKET");
  if (!neon) throw new Error("FILES_BUCKET and the NEON_STORAGE_* settings are not all set: there is no bucket to move the files to.");
  const rows = await db.select({ key: siteFiles.key, size: siteFiles.size }).from(siteFiles).orderBy(siteFiles.key);
  const waiting = { files: rows.length, bytes: rows.reduce((sum, row) => sum + row.size, 0) };
  if (!apply) return { waiting, moved: 0 };
  const store = bucketFiles(db, neon);
  const database = databaseFiles(db);
  let moved = 0;
  for (const { key } of rows) {
    const file = await database.get(key);
    if (!file) continue;
    await store.put(key, file.bytes, file.contentType);
    const head = await neon.s3.send(new HeadObjectCommand({ Bucket: neon.bucket, Key: key }));
    if (head.ContentLength !== file.bytes.byteLength) throw new Error(`${key} did not arrive whole in the bucket; it stays in the database.`);
    await database.remove(key);
    moved++;
  }
  return { waiting, moved };
}
