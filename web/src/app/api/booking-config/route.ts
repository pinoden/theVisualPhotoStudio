import { connection } from "next/server";
import { resolvePayments } from "@/server/payments";

/** GET /api/booking-config: how the browser should collect payment. No secrets. */
export async function GET() {
  await connection(); // read the environment at request time, not at build time
  const { client } = resolvePayments();
  // Why card payments are off is for the owners (the admin's overview), not for every browser.
  return Response.json(client.mode === "disabled" ? { mode: "disabled" } : client, { headers: { "Cache-Control": "no-store" } });
}
