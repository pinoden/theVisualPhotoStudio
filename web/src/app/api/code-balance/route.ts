import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { checkCodeBalance } from "@/server/code-balance";
import { clientAddress, limitRate } from "@/server/rate-limit";

/** Twenty checks in ten minutes from one address: plenty for a client, and far too few to guess a code by trying. */
const CHECKS = { max: 20, windowMs: 10 * 60_000 };

/**
 * POST /api/code-balance `{ code }`: what a code is worth, for "Check Code Balance" on the booking page. It changes
 * nothing (src/server/code-balance.ts).
 */
export async function POST(request: NextRequest) {
  const db = await getDb();
  const now = new Date();
  const check = await limitRate(db, { key: `code-balance:${clientAddress(request.headers)}`, ...CHECKS }, now);
  if (!check.allowed) {
    return Response.json(
      { ok: false, message: "Too many checks. Please wait a few minutes and try again." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(check.retryAfterMs / 1000)) } },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, message: "Malformed request." }, { status: 400 });
  }
  const code = typeof body === "object" && body !== null && "code" in body ? (body as { code: unknown }).code : "";
  const result = await checkCodeBalance(db, code, now);
  return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
}
