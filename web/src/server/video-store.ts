import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { DbLike } from "@/db/client";
import { fileStore } from "./files";
import { neonBucket } from "./neon-storage";

/**
 * Where uploaded video files are kept (question 77 in ProjectLibrary.md). On the host, Neon's object storage: the
 * `videos` bucket of the staging (or production) project, written by the browser itself through an upload address the
 * site signs, so a file far larger than a request to the site takes (4.5 MB on Vercel) arrives whole, and read by anyone
 * from the bucket, by parts as a player asks. Its settings are the site's own names (`NEON_STORAGE_*`, `VIDEO_BUCKET`),
 * never the AWS ones `neon deploy` writes into web/.env.local: so a computer of the builder's and the tests, which read
 * that file, never write to the bucket. Without them, the files go into the database (`site_files`), through the site's
 * own upload address: small files only, enough to try it and test it.
 */
export interface VideoStore {
  kind: "neon" | "database";
  /** Where the browser sends the file, with which method and headers. */
  uploadAddress(input: { id: string; key: string; contentType: string }): Promise<{ url: string; method: "PUT"; headers: Record<string, string> }>;
  /** Where a player reads it. */
  readAddress(key: string): string | null;
  /** Its size once it is there, or null. */
  sizeOf(key: string): Promise<number | null>;
  remove(key: string): Promise<void>;
}

/** A file kept in the database: at most this big (a request to the site carries it whole). */
export const DATABASE_VIDEO_MAX_BYTES = 4 * 1024 * 1024;

export function videoStore(db: DbLike): VideoStore {
  const neon = neonBucket("VIDEO_BUCKET");
  if (!neon) return databaseVideos(db);
  const s3 = neon.s3;
  return {
    kind: "neon",
    async uploadAddress({ key, contentType }) {
      const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: neon.bucket, Key: key, ContentType: contentType }), { expiresIn: 3600 });
      return { url, method: "PUT", headers: { "content-type": contentType } };
    },
    readAddress: (key) => `${neon.endpoint}/${neon.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`,
    async sizeOf(key) {
      try {
        const head = await s3.send(new HeadObjectCommand({ Bucket: neon.bucket, Key: key }));
        return head.ContentLength ?? null;
      } catch {
        return null;
      }
    },
    async remove(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: neon.bucket, Key: key }));
    },
  };
}

function databaseVideos(db: DbLike): VideoStore {
  const files = fileStore(db);
  return {
    kind: "database",
    uploadAddress: async ({ id, contentType }) => ({ url: `/api/videos/${id}/upload`, method: "PUT", headers: { "content-type": contentType } }),
    // The site serves it itself (src/app/videos/[id]/route.ts).
    readAddress: () => null,
    sizeOf: (key) => files.sizeOf(key),
    remove: (key) => files.remove(key),
  };
}
