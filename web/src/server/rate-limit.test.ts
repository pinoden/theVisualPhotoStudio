import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit";

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
