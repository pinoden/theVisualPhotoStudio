/**
 * Put the old website's photos into this site's media library and where the
 * old site showed them (src/server/old-site-import.ts). Run once per database.
 *
 *   npx tsx scripts/import-old-site-photos.ts <manifest.json> [--publish] [--as owner@address]
 *
 * The manifest and the photos it names stay outside the repository (their file
 * names hold clients' names): /old-site-photos/ at the repository's root is
 * ignored by git for them. Files are read relative to the manifest.
 *
 * Which database: DATABASE_URL when it is set (staging, production), otherwise
 * the local one in web/.data/<PGLITE_DATA_NAME or pglite>, which no running
 * server may have open. The pictures go where the site keeps its files
 * (`fileStore`). Pages get their gallery in a draft; --publish publishes it,
 * unless the page already had the owners' changes waiting.
 *
 * Who imports: --as, which must be one of OWNER_EMAILS when that is set; it is
 * recorded as the pictures' uploader and the pages' editor.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getDb } from "../src/db/client";
import { importOldSitePhotos, type OldSiteManifest } from "../src/server/old-site-import";

async function main() {
  const args = process.argv.slice(2);
  const manifestPath = args.find((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--as");
  const publish = args.includes("--publish");
  const owners = (process.env.OWNER_EMAILS ?? "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  const as = (args.includes("--as") ? args[args.indexOf("--as") + 1] : owners[0])?.trim().toLowerCase();
  if (!manifestPath) {
    console.error("Usage: npx tsx scripts/import-old-site-photos.ts <manifest.json> [--publish] [--as owner@address]");
    process.exit(2);
  }
  if (!as || !as.includes("@")) {
    console.error("Say who is importing: --as owner@address (or set OWNER_EMAILS).");
    process.exit(2);
  }
  if (owners.length > 0 && !owners.includes(as)) {
    console.error(`${as} is not one of OWNER_EMAILS: only an owner imports the old website's photos.`);
    process.exit(2);
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as OldSiteManifest;
  const folder = path.dirname(path.resolve(manifestPath));
  const read = async (file: string) => {
    const resolved = path.resolve(folder, file);
    if (!resolved.startsWith(folder + path.sep)) throw new Error("outside the manifest's folder");
    return new Uint8Array(await readFile(resolved));
  };

  const where = process.env.DATABASE_URL ? "the database in DATABASE_URL" : `the local database web/.data/${process.env.PGLITE_DATA_NAME || "pglite"}`;
  console.log(`Importing ${manifest.photos.length} photos from ${manifest.source} into ${where}, as ${as}${publish ? ", publishing page galleries" : ""}.`);
  const db = await getDb();
  const result = await importOldSitePhotos(db, { id: randomUUID(), email: as, name: as, role: "owner" }, manifest, read, {
    publish,
    now: new Date(),
    log: (line) => console.log(`  ${line}`),
  });
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  const { report } = result;
  console.log(`\nAdded to the library: ${report.uploaded} of ${manifest.photos.length} photos.`);
  for (const line of report.placed) console.log(`  placed: ${line}`);
  for (const line of report.notPlaced) console.log(`  NOT placed: ${line}`);
  for (const failed of report.failed) console.log(`  FAILED: ${failed.name}: ${failed.why}`);
  process.exit(report.failed.length > 0 || report.notPlaced.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
