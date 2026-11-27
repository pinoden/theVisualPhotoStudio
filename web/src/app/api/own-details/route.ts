import { getDb } from "@/db/client";
import { ownDetails } from "@/server/own-details";
import { getCurrentUser } from "@/server/session";

/**
 * GET /api/own-details
 * A signed-in client's own name, email address and phone number (src/server/own-details.ts), which the booking screen
 * and the membership's checkout fill in for them. The booking pages are the same page for everyone, drawn ahead of
 * time, so the screen asks here once it has started, and only when the menu's cookie says someone is signed in.
 * Answers `details: null` for a visitor, an owner and a staff member. Read with the session; never cached.
 */
export async function GET() {
  const details = await ownDetails(await getDb(), await getCurrentUser());
  return Response.json({ ok: true, details }, { headers: { "Cache-Control": "no-store, private" } });
}
