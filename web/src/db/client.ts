import path from "node:path";
import { mkdirSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

/**
 * One database type for both drivers:
 *  - DATABASE_URL set  -> a real PostgreSQL server (production, staging)
 *  - DATABASE_URL unset -> PGlite, real Postgres compiled to WebAssembly,
 *    stored in web/.data. No install needed; used for local development.
 * Tests use an in-memory PGlite per test file.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbLike = Db | Tx;

const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

async function openPglite(dataDir?: string): Promise<{ db: Db; close: () => Promise<void> }> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite({ dataDir, extensions: { btree_gist } });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { db: db as unknown as Db, close: () => client.close() };
}

async function openPostgres(url: string): Promise<{ db: Db; close: () => Promise<void> }> {
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  return { db: db as unknown as Db, close: () => pool.end() };
}

/** A fresh, migrated, empty in-memory database. For tests. */
export function createMemoryDb() {
  return openPglite(undefined);
}

/** Apply pending migrations to the server named by DATABASE_URL. */
export async function migratePostgres(url: string): Promise<void> {
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const pool = new Pool({ connectionString: url });
  try {
    await migrate(drizzle(pool, { schema }), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await pool.end();
  }
}

const globalForDb = globalThis as unknown as { __studioDb?: Promise<Db> };

/** The application database. Opened once per process. */
export function getDb(): Promise<Db> {
  if (!globalForDb.__studioDb) {
    globalForDb.__studioDb = (async () => {
      const url = process.env.DATABASE_URL;
      if (url) return (await openPostgres(url)).db;
      const { seed } = await import("./seed");
      if (process.env.NEXT_PHASE === "phase-production-build") {
        // `next build` without a database server: prerender pages from the
        // starting catalog held in memory. Build workers run in parallel and
        // PGlite's data directory can only be opened by one process.
        const { db } = await openPglite(undefined);
        await seed(db);
        return db;
      }
      if (process.env.NODE_ENV === "production" && process.env.ALLOW_PGLITE_IN_PRODUCTION !== "1") {
        throw new Error("DATABASE_URL is required in production.");
      }
      // PGLITE_DATA_NAME lets the browser tests use their own throwaway database
      // (.data/e2e). Always a plain folder name inside .data.
      const name = /^[a-z0-9-]{1,40}$/.test(process.env.PGLITE_DATA_NAME ?? "") ? process.env.PGLITE_DATA_NAME! : "pglite";
      const dataDir = path.join(process.cwd(), ".data", name);
      mkdirSync(dataDir, { recursive: true });
      const { db } = await openPglite(dataDir);
      await seed(db);
      return db;
    })();
    globalForDb.__studioDb.catch(() => {
      globalForDb.__studioDb = undefined;
    });
  }
  return globalForDb.__studioDb;
}

/** Postgres error code of a failed query, looking through driver wrappers. */
export function pgErrorCode(error: unknown): string | undefined {
  let e: unknown = error;
  for (let depth = 0; depth < 5 && e && typeof e === "object"; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

export const PG_EXCLUSION_VIOLATION = "23P01";
export const PG_UNIQUE_VIOLATION = "23505";
export const PG_DEADLOCK_DETECTED = "40P01";

/** Run a raw query and return its rows. Both drivers put them on `.rows`. */
export async function queryRows<T>(db: DbLike, query: SQL): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as { rows: T[] };
  return result.rows;
}
