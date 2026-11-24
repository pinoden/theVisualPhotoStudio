import { S3Client } from "@aws-sdk/client-s3";

/**
 * Neon's object storage, as the site reaches it (questions 77 and 78 in ProjectLibrary.md). Its settings are the site's
 * own names, `NEON_STORAGE_*` and one bucket's name each (`VIDEO_BUCKET`, `FILES_BUCKET`), set on the host's Production
 * only: never the AWS names `neon deploy` writes into web/.env.local, so a computer of the builder's and the tests, which
 * read that file, never write to a bucket. Without them, each store keeps its files in the database.
 */
export interface NeonBucket {
  s3: S3Client;
  bucket: string;
  endpoint: string;
}

let client: { key: string; s3: S3Client } | null = null;

export function neonBucket(bucketSetting: "VIDEO_BUCKET" | "FILES_BUCKET"): NeonBucket | null {
  const bucket = process.env[bucketSetting];
  const endpoint = process.env.NEON_STORAGE_ENDPOINT?.replace(/\/$/, "");
  const region = process.env.NEON_STORAGE_REGION;
  const keyId = process.env.NEON_STORAGE_KEY_ID;
  const secret = process.env.NEON_STORAGE_SECRET;
  if (!bucket || !endpoint || !region || !keyId || !secret) return null;
  const key = `${endpoint}|${region}|${keyId}`;
  if (!client || client.key !== key) {
    // Its own credentials, named: never the default chain, which on Vercel would find Vercel's own AWS keys.
    client = { key, s3: new S3Client({ forcePathStyle: true, region, endpoint, credentials: { accessKeyId: keyId, secretAccessKey: secret } }) };
  }
  return { s3: client.s3, bucket, endpoint };
}
