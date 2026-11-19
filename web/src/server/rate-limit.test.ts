import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rateLimitHits } from "@/db/schema";
import { clientAddress, limitRate, pruneRateLimits, RateLimiter } from "./rate-limit";
import { createTestWorld, minutesAfter, NOW, type TestWorld } from "./testing";

describe("RateLimiter", () => {
  it("allows requests within the limit", () => {
    const rl = new RateLimiter({ windowMs: 1000, maxRequests: 3 });
    expect(rl.check("a", 100).allowed).toBe(true);
    expect(rl.check("a", 200).allowed).toBe(true);
    expect(rl.check("a", 300).allowed).toBe(true);
  });

  it("rejects the request that exceeds the limit", () => {
    const rl = new RateLimiter({ windowMs: 1000, maxRequests: 2 });
    rl.check("a", 100);
    rl.check("a", 200);
    const third = rl.check("a", 300);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });

  it("allows again after the window expires", () => {
    const rl = new RateLimiter({ windowMs: 1000, maxRequests: 2 });
    rl.check("a", 100);
    rl.check("a", 200);
    expect(rl.check("a", 300).allowed).toBe(false);
    expect(rl.check("a", 1200).allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    const rl = new RateLimiter({ windowMs: 1000, maxRequests: 1 });
    expect(rl.check("a", 100).allowed).toBe(true);
    expect(rl.check("b", 100).allowed).toBe(true);
    expect(rl.check("a", 200).allowed).toBe(false);
    expect(rl.check("b", 200).allowed).toBe(false);
  });
});

describe("a limit counted in the database (security review, 2026-11-19)", () => {
  let world: TestWorld;
  beforeAll(async () => {
    world = await createTestWorld();
  });
  afterAll(() => world.close());
  beforeEach(() => world.reset());
  const limit = { key: "sign-in-code:203.0.113.7", max: 3, windowMs: 15 * 60_000 };
  const start = new Date(Math.ceil(NOW.getTime() / limit.windowMs) * limit.windowMs);

  it("lets a key make its number of requests in a window, counts the ones made at the same moment, and starts again in the next", async () => {
    const first = await Promise.all([0, 1, 2, 3].map(() => limitRate(world.db, limit, start)));
    expect(first.map((result) => result.allowed).sort()).toEqual([false, true, true, true]);
    expect(first.find((result) => !result.allowed)!.retryAfterMs).toBe(limit.windowMs);
    expect((await limitRate(world.db, { ...limit, key: "sign-in-code:198.51.100.2" }, start)).allowed).toBe(true);
    expect((await limitRate(world.db, limit, minutesAfter(start, 15))).allowed).toBe(true);
  });

  it("forgets windows over two days old", async () => {
    await limitRate(world.db, limit, start);
    await limitRate(world.db, limit, minutesAfter(start, 3 * 24 * 60));
    expect(await pruneRateLimits(world.db, minutesAfter(start, 3 * 24 * 60))).toBe(1);
    expect(await world.db.select().from(rateLimitHits)).toHaveLength(1);
  });

  it("reads the visitor's address from the first of x-forwarded-for", () => {
    expect(clientAddress(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientAddress(new Headers())).toBe("unknown");
  });
});
