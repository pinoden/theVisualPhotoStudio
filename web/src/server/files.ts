import { eq } from "drizzle-orm";
import { siteFiles } from "@/db/schema";
import type { DbLike } from "@/db/client";

/**
 * Where the files the owners upload are kept: pictures and fonts.
 *
 * No host has been chosen yet, and where files live depends on it, so
 * everything that stores or reads a file does it through `FileStore`. The
 * one store there is keeps the bytes in the database (`site_files`), which
 * works anywhere the site runs and needs nothing set up. A host's own file
 * storage is another `FileStore`, chosen in `fileStore`; nothing else has to
 * change, apart from moving the files that are already there.
 *
 * A key names one file for good: a new version of a picture is a new key.
 * So a file, once written, never changes, and can be cached for ever.
 */
export interface StoredFile {
  bytes: Uint8Array;
  contentType: string;
}

export interface FileStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredFile | null>;
  /** Removing a file that is not there is not an error. */
  remove(key: string): Promise<void>;
}

/** Files as rows of `site_files`. Given a transaction, a file is written or removed together with the row that names it. */
export function databaseFiles(db: DbLike): FileStore {
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
    async remove(key) {
      await db.delete(siteFiles).where(eq(siteFiles.key, key));
    },
  };
}

/** The store in use. The one place to change when a host with its own file storage is chosen. */
export function fileStore(db: DbLike): FileStore {
  return databaseFiles(db);
}
