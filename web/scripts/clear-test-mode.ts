/**
 * Make a database of test mode ready for Square's live account: remove every
 * booking and what bookings made, and keep everything the owners set up (the
 * website, the studios, prices, settings and staff). Refused on a database
 * that took real payments. See `clearTestMode` in src/server/test-mode.ts.
 * Usage: DATABASE_URL=postgres://... npm run db:clear-test-mode
 *
 * The site refuses to open a database that holds test mode's bookings once
 * the live account is set up, and says to run this.
 */
import { openPostgres } from "../src/db/client";
import { clearTestMode } from "../src/server/test-mode";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Nothing to clear.");
    process.exit(1);
  }
  const { db, close } = await openPostgres(url);
  try {
    const { bookings } = await clearTestMode(db);
    console.log(`Test mode cleared: ${bookings} bookings removed, with what they made. The website, the studios, prices, settings and staff are kept.`);
  } finally {
    await close();
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
