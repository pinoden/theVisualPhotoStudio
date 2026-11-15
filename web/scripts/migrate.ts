/**
 * Apply pending migrations to the PostgreSQL server in DATABASE_URL.
 * Usage: DATABASE_URL=postgres://... npm run db:migrate
 *
 * Local development needs no migration step: without DATABASE_URL the app
 * uses PGlite in web/.data and migrates it on start.
 */
import { migratePostgres } from "../src/db/client";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Nothing to migrate.");
    process.exit(1);
  }
  await migratePostgres(url);
  console.log("Migrations applied.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
