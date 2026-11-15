/**
 * Insert the starting catalog (studios, hours, prices, add-ons) into the
 * PostgreSQL server in DATABASE_URL. Does nothing if studios already exist.
 * Usage: DATABASE_URL=postgres://... npm run db:seed
 */
import { getDb } from "../src/db/client";
import { seed } from "../src/db/seed";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. The local PGlite database seeds itself on first start.");
    process.exit(1);
  }
  const db = await getDb();
  const inserted = await seed(db);
  console.log(inserted ? "Catalog seeded." : "Studios already exist. Nothing changed.");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
