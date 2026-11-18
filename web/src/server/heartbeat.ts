import { eq, sql } from "drizzle-orm";
import { settings as settingsTable } from "@/db/schema";
import type { DbLike } from "@/db/client";

/**
 * Whether the site's background work is alive: the scheduler that calls
 * GET /api/cron/tick every few minutes (free hours, refund retries, email,
 * payments not taken yet). When it stops nothing fails at once, but all of
 * that waits, so it has to be noticed: the overview of the admin says so, and
 * GET /api/health answers 503 for an uptime monitor.
 *
 * The moment of the last run is kept in the settings table under a key that
 * `mergeSettings` ignores and `saveSetting` refuses, as the getting-in text
 * is: it never travels with the settings to the browser.
 */

const SCHEDULER_KEY = "schedulerLastRunAt";

/** The scheduler is expected every few minutes. Past this many, it is taken to have stopped. */
export const SCHEDULER_STALE_MINUTES = 15;

/** Record a run of the scheduler. Only the scheduler's own address calls this, not a run started by hand. */
export async function recordSchedulerRun(db: DbLike, now: Date): Promise<void> {
  const value = now.toISOString();
  await db
    .insert(settingsTable)
    .values({ key: SCHEDULER_KEY, value })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value } });
}

/** When the scheduler last ran, or null when it never has. */
export async function schedulerLastRun(db: DbLike): Promise<Date | null> {
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, SCHEDULER_KEY)).limit(1);
  if (typeof row?.value !== "string") return null;
  const at = new Date(row.value);
  return Number.isFinite(at.getTime()) ? at : null;
}

export interface SchedulerState {
  lastRunAt: string | null;
  /** Whole minutes since the last run, or null when it never ran. */
  minutesAgo: number | null;
  /** It ran within the last `SCHEDULER_STALE_MINUTES` minutes. */
  fresh: boolean;
}

export function schedulerState(lastRun: Date | null, now: Date): SchedulerState {
  if (!lastRun) return { lastRunAt: null, minutesAgo: null, fresh: false };
  const minutes = Math.max(0, Math.floor((now.getTime() - lastRun.getTime()) / 60_000));
  return { lastRunAt: lastRun.toISOString(), minutesAgo: minutes, fresh: minutes < SCHEDULER_STALE_MINUTES };
}

export interface Health {
  ok: boolean;
  database: "ok" | "unreachable";
  scheduler: SchedulerState | null;
}

/**
 * What GET /api/health answers. `requireScheduler`: whether a scheduler that
 * stopped, or never ran, makes the answer not ok. In production it does; in
 * development nothing calls the scheduler, so it is only reported.
 */
export async function checkHealth(db: DbLike, now: Date, requireScheduler: boolean): Promise<Health> {
  try {
    await db.execute(sql`select 1`);
  } catch {
    return { ok: false, database: "unreachable", scheduler: null };
  }
  const scheduler = schedulerState(await schedulerLastRun(db), now);
  return { ok: scheduler.fresh || !requireScheduler, database: "ok", scheduler };
}
