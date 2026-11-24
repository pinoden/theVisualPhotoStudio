/**
 * Move the pictures and fonts still kept in the database (`site_files`) into Neon's bucket for them (question 78 in
 * ProjectLibrary.md; `moveFilesToBucket` in src/server/files.ts). The site reads a file from either place, so it can
 * run while the site is up, and again if it stops.
 *
 *   DATABASE_URL=… FILES_BUCKET=site-files NEON_STORAGE_ENDPOINT=… NEON_STORAGE_REGION=… NEON_STORAGE_KEY_ID=… \
 *     NEON_STORAGE_SECRET=… npx tsx scripts/move-files-to-bucket.ts           counts them; changes nothing
 *   … npx tsx scripts/move-files-to-bucket.ts --yes                             moves them
 *
 * The database and the bucket must be the same Neon branch's.
 */
import { openPostgres } from "../src/db/client";
import { moveFilesToBucket } from "../src/server/files";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Nothing to move.");
    process.exit(1);
  }
  const apply = process.argv.slice(2).includes("--yes");
  const { db, close } = await openPostgres(url);
  try {
    const { waiting, moved } = await moveFilesToBucket(db, { apply });
    console.log(`In the database: ${waiting.files} files, ${(waiting.bytes / 1024 / 1024).toFixed(1)} MB.`);
    console.log(apply ? `Moved to the bucket: ${moved}.` : "Nothing was changed. To move them, run it again with --yes.");
  } finally {
    await close();
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
