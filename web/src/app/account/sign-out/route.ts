import { closeSession } from "@/server/session";

/**
 * Signing out is a plain form post to this address, not a server action, so
 * that the browser loads a new document afterwards. The router keeps recently
 * visited pages in the document, hidden. After a navigation inside the app,
 * the pages a signed-in person had open (the owner's bookings and settings)
 * would still be there for anyone who opened the browser's inspector.
 */
export async function POST(request: Request): Promise<Response> {
  if (!sameSite(request)) return new Response(null, { status: 403 });
  await closeSession();
  return new Response(null, { status: 303, headers: { Location: "/", "Cache-Control": "no-store" } });
}

/** A form on another site may not sign someone out. Browsers name the sending site in `Origin`. */
function sameSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
