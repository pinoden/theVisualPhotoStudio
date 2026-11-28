import { connection } from "next/server";
import type { ComponentProps } from "react";
import { BookingFlow } from "@/components/BookingFlow";
import { getDb } from "@/db/client";
import { ownDetails } from "@/server/own-details";
import { getCurrentUser } from "@/server/session";

/**
 * The booking screen, with a signed-in client's own name, email address and phone number for it to fill in
 * (src/server/own-details.ts; the owners' decision of 2026-11-27). The booking pages are drawn ahead of time for
 * everyone; this part reads the session, so it is drawn for each request, inside the page's `<Suspense>`.
 *
 * The details come with the page and not by a request of the page's own: WebKit reports a request still on its way
 * when a page is left as an error of that page, and a client who opens the booking page and goes on at once would
 * meet it (CI's WebKit jobs, 2026-11-27).
 */
export async function BookingScreen(props: Omit<ComponentProps<typeof BookingFlow>, "own">) {
  // Drawn for each request, and said so before anything else is read ("Cache Components is on" in ProjectLibrary.md):
  // without it a production build drew this part ahead of time, met the session's clock and failed (2026-11-27).
  await connection();
  const own = await ownDetails(await getDb(), await getCurrentUser());
  return <BookingFlow {...props} own={own} />;
}
