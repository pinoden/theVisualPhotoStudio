import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { quoteSelection } from "@/server/bookings";
import { resolvePayments } from "@/server/payments";

/**
 * POST /api/quote: the server's price for a selection, with a code applied.
 * The booking screen calls it when the customer applies a code. It changes
 * nothing; the code is only spent when the booking is made.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, code: "invalid_input", message: "Malformed request." }, { status: 400 });
  }
  const result = await quoteSelection(await getDb(), body, new Date(), resolvePayments().provider?.name ?? null);
  if (result.ok) return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  return Response.json({ ok: false, code: result.code, message: result.message }, { status: result.status });
}
