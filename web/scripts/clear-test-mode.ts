/**
 * Make a database of test mode ready for Square's live account: remove every
 * booking and what bookings made, and keep everything the owners set up (the
 * website, the studios, prices, settings and staff). Refused on a database
 * that has been used with the live account. See `clearTestMode` in
 * src/server/test-mode.ts.
 *
 *   DATABASE_URL=postgres://... npm run db:clear-test-mode            lists what it would remove and keep; changes nothing
 *   DATABASE_URL=postgres://... npm run db:clear-test-mode -- --yes   removes it
 *
 * The site refuses to open a database of test mode once the live account is
 * set up, and says to run this.
 */
import { openPostgres } from "../src/db/client";
import { clearTestMode, describeTestMode, testModeContents } from "../src/server/test-mode";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Nothing to clear.");
    process.exit(1);
  }
  const yes = process.argv.slice(2).includes("--yes");
  const { db, close } = await openPostgres(url);
  try {
    if (!yes) {
      console.log(["What clearing test mode would do:", "", ...describeTestMode(await testModeContents(db, new Date()))].join("\n"));
      console.log("\nNothing was changed. To do it, run: npm run db:clear-test-mode -- --yes");
      return;
    }
    const cleared = await clearTestMode(db, new Date());
    console.log(["Test mode cleared. The database is ready for Square's live account.", "", ...describeTestMode(cleared)].join("\n"));
  } finally {
    await close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
