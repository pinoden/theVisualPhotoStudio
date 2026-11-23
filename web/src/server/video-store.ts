import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { eq } from "drizzle-orm";
import { siteFiles } from "@/db/schema";
import type { DbLike } from "@/db/client";
import { fileStore } from "./files";

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

function neonSettings(): { bucket: string; endpoint: string; region: string; keyId: string; secret: string } | null {
  const bucket = process.env.VIDEO_BUCKET;
  const endpoint = process.env.NEON_STORAGE_ENDPOINT;
  const region = process.env.NEON_STORAGE_REGION;
  const keyId = process.env.NEON_STORAGE_KEY_ID;
  const secret = process.env.NEON_STORAGE_SECRET;
  return bucket && endpoint && region && keyId && secret ? { bucket, endpoint: endpoint.replace(/\/$/, ""), region, keyId, secret } : null;
}

let client: { key: string; s3: S3Client } | null = null;

export function videoStore(db: DbLike): VideoStore {
  const neon = neonSettings();
  if (!neon) return databaseVideos(db);
  const cacheKey = `${neon.endpoint}|${neon.keyId}`;
  if (!client || client.key !== cacheKey) {
    client = {
      key: cacheKey,
      // Its own credentials, named: never the default chain, which on Vercel would find Vercel's own AWS keys.
      s3: new S3Client({ forcePathStyle: true, region: neon.region, endpoint: neon.endpoint, credentials: { accessKeyId: neon.keyId, secretAccessKey: neon.secret } }),
    };
  }
  const s3 = client.s3;
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
    async sizeOf(key) {
      const [row] = await db.select({ size: siteFiles.size }).from(siteFiles).where(eq(siteFiles.key, key)).limit(1);
      return row?.size ?? null;
    },
    remove: (key) => files.remove(key),
  };
}
