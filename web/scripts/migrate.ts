/**
 * Apply pending migrations to the PostgreSQL server in DATABASE_URL, then add
 * the pages the website was built with that the database has never had
 * (`ensureBuiltInPages` in src/server/pages.ts).
 * Usage: DATABASE_URL=postgres://... npm run db:migrate
 *
 * Local development needs no migration step: without DATABASE_URL the app
 * uses PGlite in web/.data and migrates it on start.
 */
import { migratePostgres, openPostgres } from "../src/db/client";
import { ensureBuiltInPages } from "../src/server/pages";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Nothing to migrate.");
    process.exit(1);
  }
  await migratePostgres(url);
  console.log("Migrations applied.");
  // Opened as it is, not through `getDb`: that checks the database against the card processor set up, and a shell
  // with only DATABASE_URL has the pretend one, which a database of real bookings refuses.
  const { db, close } = await openPostgres(url);
  try {
    const added = await ensureBuiltInPages(db, new Date());
    console.log(added > 0 ? `Added ${added} of the website's own pages.` : "The website's own pages were all there already.");
  } finally {
    await close();
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
