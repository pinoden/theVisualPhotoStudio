import { draftMode } from "next/headers";
import { closeSession, sameSiteRequest } from "@/server/session";

/**
 * Signing out is a plain form post to this address, not a server action, so
 * that the browser loads a new document afterwards. The router keeps recently
 * visited pages in the document, hidden. After a navigation inside the app,
 * the pages a signed-in person had open (the owner's bookings and settings)
 * would still be there for anyone who opened the browser's inspector.
 */
export async function POST(request: Request): Promise<Response> {
  if (!sameSiteRequest(request)) return new Response(null, { status: 403 });
  await closeSession();
  // A preview of unpublished website changes ends with the session (src/server/site.ts).
  (await draftMode()).disable();
  return new Response(null, { status: 303, headers: { Location: "/", "Cache-Control": "no-store" } });
}

