import { connection } from "next/server";
import { resolvePayments } from "@/server/payments";

/** GET /api/booking-config: how the browser should collect payment. No secrets. */
export async function GET() {
  await connection(); // read the environment at request time, not at build time
  return Response.json(resolvePayments().client, { headers: { "Cache-Control": "no-store" } });
}
