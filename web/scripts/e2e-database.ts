/**
 * The browser tests' database for a production build (`E2E_BUILD=1`, playwright.config.ts), made before `next build`,
 * in .data/<PGLITE_DATA_NAME>: migrated, seeded and given the website's own pages, as the site's server makes one on
 * its first start. A copy goes to the file named by PGLITE_BUILD_SNAPSHOT, which the build reads (src/db/client.ts):
 * the pages it prerenders then hold the ids that the server, opening this database, answers with. A host's build reads
 * the site's own database, so its pages do too.
 *
 * Usage, as playwright.config.ts runs it:
 *   DATABASE_URL="" PGLITE_DATA_NAME=e2e-prod PGLITE_BUILD_SNAPSHOT=.data/e2e-prod.tar.gz npx tsx scripts/e2e-database.ts
 */
import { writeFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { getDb } from "../src/db/client";

async function main() {
  const file = process.env.PGLITE_BUILD_SNAPSHOT;
  if (!file || process.env.DATABASE_URL || !process.env.PGLITE_DATA_NAME) {
    throw new Error("Set PGLITE_DATA_NAME and PGLITE_BUILD_SNAPSHOT, with no DATABASE_URL: this makes a PGlite database.");
  }
  // Drizzle's PGlite database carries its client, which can write a copy of itself.
  const client = ((await getDb()) as unknown as { $client: PGlite }).$client;
  writeFileSync(file, Buffer.from(await (await client.dumpDataDir("gzip")).arrayBuffer()));
  await client.close();
  console.log(`The tests' database is in .data/${process.env.PGLITE_DATA_NAME}, and a copy for the build in ${file}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
