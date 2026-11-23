import type { NextRequest } from "next/server";
import { isService } from "@/lib/domain/services";
import { getDb } from "@/db/client";
import { loadCatalog } from "@/server/catalog";
import { clientAddress, limitRate } from "@/server/rate-limit";
import { joinWaitlist } from "@/server/waitlist";

/** Ten places asked for in an hour from one address: plenty for a client, and too few to fill the list. */
const JOINS = { max: 10, windowMs: 60 * 60_000 };

/**
 * POST /api/waitlist: put a client on the waitlist for a time that is not free (src/server/waitlist.ts). Answers
 * whether they are on it, or that a time that fits is free now and can be booked.
 */
export async function POST(request: NextRequest) {
  const db = await getDb();
  const now = new Date();
  const check = await limitRate(db, { key: `waitlist:${clientAddress(request.headers)}`, ...JOINS }, now);
  if (!check.allowed) return Response.json({ ok: false, code: "rate_limited", message: "Too many requests. Please wait a while and try again." }, { status: 429 });
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, code: "invalid", message: "Malformed request." }, { status: 400 });
  }
  const number = (value: unknown) => (typeof value === "number" ? value : Number.NaN);
  const text = (value: unknown) => (typeof value === "string" ? value.slice(0, 200) : "");
  const result = await joinWaitlist(
    db,
    await loadCatalog(db),
    {
      studioIds: Array.isArray(body.studioIds) ? body.studioIds.filter((id): id is string => typeof id === "string").slice(0, 10) : [],
      photography: body.photography === true,
      service: isService(body.service) ? body.service : "photography",
      durationMinutes: number(body.durationMinutes),
      date: text(body.date),
      fromMinute: number(body.fromMinute),
      toMinute: number(body.toMinute),
      firstName: text(body.firstName),
      lastName: text(body.lastName),
      email: text(body.email),
    },
    now,
  );
  return Response.json(result.ok ? { ok: true } : { ok: false, code: result.code, message: result.message }, { status: result.ok ? 201 : result.code === "invalid" ? 400 : 409 });
}
