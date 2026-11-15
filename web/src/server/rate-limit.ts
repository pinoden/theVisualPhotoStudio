/**
 * In-memory sliding-window rate limiter keyed by IP address. Each key
 * gets `maxRequests` in `windowMs`. The store prunes itself so it does
 * not grow without bound.
 *
 * Good enough for a single-process deployment. Behind a load balancer
 * with several instances, replace this with a Redis counter or the
 * provider's built-in rate limiting.
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
