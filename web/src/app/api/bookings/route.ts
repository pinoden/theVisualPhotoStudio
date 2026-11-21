import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { createBooking } from "@/server/bookings";
import { mayUseTestTools } from "@/server/browser-test-server";
import { resolvePayments } from "@/server/payments";
import { clientAddress, limitRate } from "@/server/rate-limit";
import { flushEmailsSoon, ownerNotifyEmail } from "@/server/runtime";

// Ten booking attempts a minute from one address. The browser tests all come from one address and make
// more than that, so their server raises the number with BOOKING_REQUESTS_PER_MINUTE. Production ignores it,
// but on their own server (`mayUseTestTools`).
const perMinute = mayUseTestTools() ? Number(process.env.BOOKING_REQUESTS_PER_MINUTE) || 10 : 10;

/** POST /api/bookings: validate, hold the slot, charge, confirm. */
export async function POST(request: NextRequest) {
  const check = await limitRate(await getDb(), { key: `booking:${clientAddress(request.headers)}`, max: perMinute, windowMs: 60_000 }, new Date());
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
    ownerEmail: ownerNotifyEmail(),
  });

  if (result.ok) {
    flushEmailsSoon();
    return Response.json(result, { status: 201 });
  }
  return Response.json({ ok: false, code: result.code, message: result.message }, { status: result.status });
}
