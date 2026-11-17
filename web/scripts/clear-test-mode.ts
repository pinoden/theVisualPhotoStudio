/**
 * Remove test mode's bookings and what they made, and nothing else: bookings
 * of real money, the website, the studios, prices, settings and staff stay.
 * Run before the live account is set up, and whenever the site refuses to
 * start because test mode's bookings are in a database of real money. See
 * `clearTestMode` in src/server/test-mode.ts.
 *
 *   DATABASE_URL=postgres://... npm run db:clear-test-mode            lists what it would remove and keep; changes nothing
 *   DATABASE_URL=postgres://... npm run db:clear-test-mode -- --yes   removes it
 *
 * Stop every server running in test mode on this database first: what it
 * books afterwards is test mode's again.
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
      const contents = await testModeContents(db, new Date());
      console.log(["What clearing test mode would do:", "", ...describeTestMode(contents)].join("\n"));
      if (contents.bookings > 0) console.log("\nNothing was changed. To do it, run: npm run db:clear-test-mode -- --yes");
      return;
    }
    const cleared = await clearTestMode(db, new Date());
    console.log([cleared.bookings > 0 ? "Test mode cleared." : "Nothing was changed.", "", ...describeTestMode(cleared)].join("\n"));
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
