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

/**
 * The address with its SSL mode spelled out as the driver treats it. node-postgres now reads "prefer", "require" and
 * "verify-ca" as "verify-full" (the server's certificate is checked against the system's authorities, as Neon's pass),
 * and warns on each connection until the address says so. An address without SSL, or with "disable" or
 * "verify-full", is left as it is.
 */
export function withVerifiedSsl(url: string): string {
  const mode = /([?&])sslmode=(prefer|require|verify-ca)(?=&|$)/i;
  return url.replace(mode, "$1sslmode=verify-full");
}

/** The PostgreSQL server named by `url`, opened as it is: no migrations, no checks. For scripts. */
export async function openPostgres(url: string): Promise<{ db: Db; close: () => Promise<void> }> {
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const pool = new Pool({ connectionString: withVerifiedSsl(url) });
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
  const pool = new Pool({ connectionString: withVerifiedSsl(url) });
  try {
    await migrate(drizzle(pool, { schema }), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await pool.end();
  }
}

/**
 * A database opened, then made ready by `ready`: closed again when that fails (a database refused by the check of
 * src/server/test-mode.ts above all), so that nothing of it stays open while the opening is tried again.
 */
export async function readyOrClosed(opened: { db: Db; close: () => Promise<void> }, ready: (db: Db) => Promise<void>): Promise<Db> {
  try {
    await ready(opened.db);
  } catch (error) {
    await opened.close().catch(() => undefined);
    throw error;
  }
  return opened.db;
}

/**
 * One opening, given to every caller. One that failed (a database server out of reach, a database refused) is given
 * to the callers that come in the next `retryAfterMs` too, then tried again: otherwise every request, and every call
 * of a request, would open the database anew, and a refused one is opened in full before it is refused.
 */
export function openOnce<T>(open: () => Promise<T>, retryAfterMs: number, clock: () => number = Date.now): () => Promise<T> {
  let opening: Promise<T> | undefined;
  let retryAt: number | undefined;
  return () => {
    if (opening && retryAt !== undefined && clock() >= retryAt) {
      opening = undefined;
      retryAt = undefined;
    }
    if (!opening) {
      const attempt = open();
      opening = attempt;
      attempt.catch(() => {
        if (opening === attempt) retryAt = clock() + retryAfterMs;
      });
    }
    return opening;
  };
}

/** How long a database that could not be opened, or was refused, is not tried again. */
export const REOPEN_AFTER_MS = 10_000;

async function openAppDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  // A database holds test money or live money, never both: one that would mix them with the processor set up now is
  // refused, with what to do (src/server/test-mode.ts). Imported here, as the pages are below: that module needs this one.
  const oneKindOfMoney = async (db: Db) => {
    const [{ assertOneKindOfMoney }, { resolvePayments }] = await Promise.all([import("../server/test-mode"), import("../server/payments")]);
    await assertOneKindOfMoney(db, resolvePayments().provider?.name ?? null);
  };
  if (url) return readyOrClosed(await openPostgres(url), oneKindOfMoney);
  const { seed } = await import("./seed");
  // The pages the website was built with, into a database that never had them (src/server/pages.ts).
  const { ensureBuiltInPages } = await import("../server/pages");
  if (process.env.NEXT_PHASE === "phase-production-build") {
    // `next build` without a database server: prerender pages from the
    // starting catalog held in memory. Build workers run in parallel and
    // PGlite's data directory can only be opened by one process.
    const { db } = await openPglite(undefined);
    await seed(db);
    await ensureBuiltInPages(db, new Date());
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
  return readyOrClosed(await openPglite(dataDir), async (db) => {
    await seed(db);
    await ensureBuiltInPages(db, new Date());
    await oneKindOfMoney(db);
  });
}

// On globalThis, so that the development server's reloading of this module keeps the one database it opened.
const globalForDb = globalThis as unknown as { __studioDbOpen?: () => Promise<Db> };

/** The application database. Opened once per process. */
export function getDb(): Promise<Db> {
  globalForDb.__studioDbOpen ??= openOnce(openAppDb, REOPEN_AFTER_MS);
  return globalForDb.__studioDbOpen();
}

/** Whether `db` is a transaction: drizzle's transaction can be rolled back, the database itself cannot. */
export function isTransaction(db: DbLike): boolean {
  return typeof (db as { rollback?: unknown }).rollback === "function";
}

/**
 * Queries that do not depend on each other: at once on the database, and one after another on a transaction, which
 * has a single connection. node-postgres runs a query given to a busy connection after the one before, with a warning
 * that its next major version refuses it (seen by the tester on 2026-11-17, at a publish and at the clear of test mode).
 */
export async function together<const Q extends readonly (() => unknown)[]>(
  db: DbLike,
  queries: Q,
): Promise<{ -readonly [K in keyof Q]: Awaited<ReturnType<Q[K]>> }> {
  type Results = { -readonly [K in keyof Q]: Awaited<ReturnType<Q[K]>> };
  if (!isTransaction(db)) return (await Promise.all(queries.map((query) => query()))) as Results;
  const results: unknown[] = [];
  for (const query of queries) results.push(await query());
  return results as Results;
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
