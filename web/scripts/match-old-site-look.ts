/**
 * Show the old website's pictures the way it showed them, on the home,
 * photography and price pages (src/server/old-site-look.ts). Run after
 * scripts/import-old-site-photos.ts, whose photos it places; a second run
 * changes nothing.
 *
 *   npx tsx scripts/match-old-site-look.ts [--as owner@address]
 *
 * The pages are saved as drafts. Publish each in the admin (Website → Pages →
 * the page → Publish): the page editor checks it on phones first. Before
 * publishing, Preview shows it; after, the page's history brings back the
 * version the run names, should the owners want it back.
 *
 * Which database: DATABASE_URL when it is set (staging, production), otherwise
 * the local one in web/.data/<PGLITE_DATA_NAME or pglite>, which no running
 * server may have open. Who changes the pages: --as, which must be one of
 * OWNER_EMAILS when that is set; it is recorded as the drafts' author.
 */
import { randomUUID } from "node:crypto";
import { getDb } from "../src/db/client";
import { applyOldSiteLook } from "../src/server/old-site-look";

async function main() {
  const args = process.argv.slice(2);
  const owners = (process.env.OWNER_EMAILS ?? "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  const as = (args.includes("--as") ? args[args.indexOf("--as") + 1] : owners[0])?.trim().toLowerCase();
  if (!as || !as.includes("@")) {
    console.error("Say who changes the pages: --as owner@address (or set OWNER_EMAILS).");
    process.exit(1);
  }
  if (owners.length > 0 && !owners.includes(as)) {
    console.error(`${as} is not one of OWNER_EMAILS: only an owner changes the website's pages.`);
    process.exit(1);
  }
  const where = process.env.DATABASE_URL ? "the database in DATABASE_URL" : `the local database web/.data/${process.env.PGLITE_DATA_NAME || "pglite"}`;
  console.log(`Placing the old website's pictures on its pages' drafts in ${where}, as ${as}.`);
  const db = await getDb();
  const result = await applyOldSiteLook(db, { id: randomUUID(), email: as, name: as, role: "owner" }, new Date());
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  for (const page of result.pages) {
    if (page.skipped) console.log(`  ${page.path}: left alone: ${page.skipped}.`);
    else if (page.changes.length === 0) console.log(`  ${page.path}: has everything already.`);
    else console.log(`  ${page.path} (page ${page.id}): ${page.changes.join("; ")}. Draft saved; the website shows version ${page.versionBefore ?? "none"} until it is published.`);
  }
  for (const what of result.missing) console.log(`  NOT in the library: ${what}. What it was for was left out.`);
  process.exit(result.missing.length > 0 || result.pages.some((page) => page.skipped) ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
