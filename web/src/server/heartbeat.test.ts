import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkHealth, recordSchedulerRun, SCHEDULER_STALE_MINUTES, schedulerLastRun, schedulerState } from "./heartbeat";
import { loadSettings, saveSetting } from "./settings";
import { createTestWorld, NOW, type TestWorld } from "./testing";

let world: TestWorld;
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(() => world.reset());

const minutesAfter = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);

describe("the scheduler's heartbeat", () => {
  it("is unknown until the scheduler runs, then keeps the moment of its last run", async () => {
    expect(await schedulerLastRun(world.db)).toBeNull();
    await recordSchedulerRun(world.db, NOW);
    expect(await schedulerLastRun(world.db)).toEqual(NOW);
    const later = minutesAfter(NOW, 5);
    await recordSchedulerRun(world.db, later);
    expect(await schedulerLastRun(world.db)).toEqual(later);
  });

  it("is fresh for 15 minutes after a run, and stale from then on", () => {
    expect(SCHEDULER_STALE_MINUTES).toBe(15);
    expect(schedulerState(null, NOW)).toEqual({ lastRunAt: null, minutesAgo: null, fresh: false });
    expect(schedulerState(NOW, minutesAfter(NOW, 14.9))).toMatchObject({ minutesAgo: 14, fresh: true });
    expect(schedulerState(NOW, minutesAfter(NOW, 15))).toMatchObject({ minutesAgo: 15, fresh: false });
    // A clock a little behind the run's does not make it look older.
    expect(schedulerState(NOW, minutesAfter(NOW, -1))).toMatchObject({ minutesAgo: 0, fresh: true });
  });

  it("never travels with the settings, and cannot be set as one", async () => {
    await recordSchedulerRun(world.db, NOW);
    expect(Object.keys(await loadSettings(world.db))).not.toContain("schedulerLastRunAt");
    expect(await saveSetting(world.db, "schedulerLastRunAt", NOW.toISOString())).toBe(false);
  });
});

describe("the health check", () => {
  it("is ok in development while nothing calls the scheduler, and says so", async () => {
    expect(await checkHealth(world.db, NOW, false)).toEqual({
      ok: true,
      database: "ok",
      scheduler: { lastRunAt: null, minutesAgo: null, fresh: false },
    });
  });

  it("in production needs a scheduler that ran in the last 15 minutes", async () => {
    expect((await checkHealth(world.db, NOW, true)).ok).toBe(false); // never ran
    await recordSchedulerRun(world.db, NOW);
    expect(await checkHealth(world.db, minutesAfter(NOW, 10), true)).toMatchObject({ ok: true, database: "ok", scheduler: { minutesAgo: 10, fresh: true } });
    expect(await checkHealth(world.db, minutesAfter(NOW, 20), true)).toMatchObject({ ok: false, database: "ok", scheduler: { minutesAgo: 20, fresh: false } });
  });

  it("is not ok when the database does not answer", async () => {
    const broken = { execute: async () => Promise.reject(new Error("connection refused")) } as unknown as typeof world.db;
    expect(await checkHealth(broken, NOW, false)).toEqual({ ok: false, database: "unreachable", scheduler: null });
  });
});
