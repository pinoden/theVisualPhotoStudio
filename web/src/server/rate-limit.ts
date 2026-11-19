import { lt, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { rateLimitHits } from "@/db/schema";

/**
 * In-memory sliding-window rate limiter keyed by IP address. Each key
 * gets `maxRequests` in `windowMs`. The store prunes itself so it does
 * not grow without bound.
 *
 * Each server copy keeps its own: the site's limits use `limitRate`
 * below, which counts in the database. Kept for the tests that use it.
 */
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX = 10;
const PRUNE_INTERVAL_MS = 5 * 60_000;

interface Entry {
  timestamps: number[];
}

export interface RateLimitConfig {
  windowMs?: number;
  maxRequests?: number;
}

export class RateLimiter {
  private store = new Map<string, Entry>();
  private windowMs: number;
  private maxRequests: number;
  private lastPrune = Date.now();

  constructor(config: RateLimitConfig = {}) {
    this.windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxRequests = config.maxRequests ?? DEFAULT_MAX;
  }

  check(key: string, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
    this.pruneIfDue(now);
    const cutoff = now - this.windowMs;
    let entry = this.store.get(key);
    if (entry) {
      entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
    } else {
      entry = { timestamps: [] };
      this.store.set(key, entry);
    }

    if (entry.timestamps.length >= this.maxRequests) {
      const oldest = entry.timestamps[0];
      return { allowed: false, retryAfterMs: oldest + this.windowMs - now };
    }
    entry.timestamps.push(now);
    return { allowed: true, retryAfterMs: 0 };
  }

  private pruneIfDue(now: number) {
    if (now - this.lastPrune < PRUNE_INTERVAL_MS) return;
    this.lastPrune = now;
    const cutoff = now - this.windowMs;
    for (const [key, entry] of this.store) {
      entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
      if (entry.timestamps.length === 0) this.store.delete(key);
    }
  }
}

// ── Limits kept in the database ──────────────────────────────────────────────

export interface RateLimit {
  /** What is counted, and from whom: "booking:203.0.113.7". */
  key: string;
  max: number;
  windowMs: number;
}

/**
 * Count one request against `limit`, in the database, so that every copy of the server counts against the same limit
 * (the security review of 2026-11-19: on Vercel each copy kept its own count). Fixed windows: a key gets `max` requests
 * in each `windowMs` from the epoch. The count goes up in one statement, so requests at the same moment are each counted.
 */
export async function limitRate(db: DbLike, limit: RateLimit, now: Date): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const start = Math.floor(now.getTime() / limit.windowMs) * limit.windowMs;
  const [row] = await db
    .insert(rateLimitHits)
    .values({ key: limit.key.slice(0, 200), windowStart: new Date(start), count: 1 })
    .onConflictDoUpdate({ target: [rateLimitHits.key, rateLimitHits.windowStart], set: { count: sql`${rateLimitHits.count} + 1` } })
    .returning({ count: rateLimitHits.count });
  const allowed = row.count <= limit.max;
  return { allowed, retryAfterMs: allowed ? 0 : start + limit.windowMs - now.getTime() };
}

/** Remove the counts of windows that ended more than a day ago. From the scheduled task. */
export async function pruneRateLimits(db: DbLike, now: Date): Promise<number> {
  const removed = await db.delete(rateLimitHits).where(lt(rateLimitHits.windowStart, new Date(now.getTime() - 2 * 86_400_000))).returning({ key: rateLimitHits.key });
  return removed.length;
}

/** The address a request came from: the first of x-forwarded-for, which Vercel sets itself. */
export function clientAddress(headers: { get(name: string): string | null }): string {
  return headers.get("x-forwarded-for")?.split(",")[0].trim().slice(0, 64) || "unknown";
}
