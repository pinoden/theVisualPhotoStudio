/**
 * Insert the starting catalog (studios, hours, prices, add-ons) into the
 * PostgreSQL server in DATABASE_URL. Does nothing if studios already exist.
 * Usage: DATABASE_URL=postgres://... npm run db:seed
 */
import { openPostgres, pgErrorCode } from "../src/db/client";
import { seed } from "../src/db/seed";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. The local PGlite database seeds itself on first start.");
    process.exit(1);
  }
  // Opened as it is, not through `getDb`, which checks the database against the card processor set up (see migrate.ts).
  const { db, close } = await openPostgres(url);
  try {
    const inserted = await seed(db);
    console.log(inserted ? "Catalog seeded." : "Studios already exist. Nothing changed.");
  } finally {
    await close();
  }
  process.exit(0);
}

main().catch((error) => {
  // 42P01: a table that does not exist. The database was never migrated.
  if (pgErrorCode(error) === "42P01") console.error("The database has no tables yet: run `npm run db:migrate` first, then this again.");
  else console.error(error);
  process.exit(1);
});
