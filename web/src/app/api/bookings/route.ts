import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { createBooking } from "@/server/bookings";
import { resolvePayments } from "@/server/payments";
import { RateLimiter } from "@/server/rate-limit";
import { flushEmailsSoon } from "@/server/runtime";

const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 10 });

/** POST /api/bookings: validate, hold the slot, charge, confirm. */
export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const check = limiter.check(ip);
  if (!check.allowed) {
    return Response.json(
      { ok: false, code: "rate_limited", message: "Too many requests. Please wait a moment." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(check.retryAfterMs / 1000)) } },
    );
  }

  if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
    return Response.json({ ok: false, code: "invalid_input", message: "Expected JSON." }, { status: 415 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, code: "invalid_input", message: "Malformed request." }, { status: 400 });
  }

  const db = await getDb();
  const result = await createBooking(db, body, {
    now: new Date(),
    payments: resolvePayments().provider,
    baseUrl: process.env.SITE_URL || request.nextUrl.origin,
  });

  if (result.ok) {
    flushEmailsSoon();
    return Response.json(result, { status: 201 });
  }
  return Response.json({ ok: false, code: result.code, message: result.message }, { status: result.status });
}
