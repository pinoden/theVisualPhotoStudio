import type { FullConfig } from "@playwright/test";

/**
 * The dev server compiles each page the first time it is requested, which is
 * slow and can reload the page under a test. Request every page once before
 * the tests start so they run against compiled pages.
 */
const PATHS = [
  "/",
  "/studios",
  "/rates",
  "/policies",
  "/faq",
  "/contact",
  "/services",
  "/book",
  "/account/sign-in",
  "/account",
  "/staff",
  "/admin",
  "/admin/bookings",
  "/admin/staff",
  "/admin/prices",
  "/admin/studios", "/admin/calendar", "/admin/calendar/new", "/admin/photography", "/book/photography",
  "/admin/hours",
  "/admin/codes",
  "/admin/memberships",
  "/admin/settings",
  "/admin/emails",
  "/admin/emails/booking_confirmation",
  "/admin/website",
  "/admin/website/design",
  "/admin/website/navigation",
  "/admin/website/media",
  "/admin/website/media/collections",
  "/admin/website/fonts",
  "/admin/website/pages",
  // Pages with an id in their address: an id that does not exist still compiles the page. The page editor is
  // the largest of all, and compiling it while a test waits for it took longer than the test waits.
  "/admin/website/pages/00000000-0000-4000-8000-000000000000",
  "/admin/website/pages/00000000-0000-4000-8000-000000000000/check",
  "/admin/website/media/collections/00000000-0000-4000-8000-000000000000",
  // An appointment's page, the customers' pages, a client's account and the page a payment link leads to: each was
  // compiled inside the first test that opened it, which on a busy machine took longer than that test waits (the
  // staff test, 2026-11-17, with the machine's load at 9).
  "/admin/appointments/VS-AAAAAA",
  "/admin/customers",
  "/admin/customers/warm-up%40example.com",
  "/account/appointments",
  "/account/rewards",
  "/account/receipts",
  "/account/receipts/VS-AAAAAA",
  "/account/receipts/VS-AAAAAA/pdf",
  "/account/receipts/year/2026/pdf",
  "/pay/00000000-0000-4000-8000-000000000000",
  // The proxy, which runs only for the phone check's own addresses (src/proxy.ts).
  "/?website-check=design",
  "/dev/outbox",
  "/booking/VS-AAAAAA?t=warm-up-warm-up-warm-up",
  "/api/availability?date=2030-01-09",
  // The endpoints a booking posts to: asked for with GET, they answer that they take no GET, and are compiled.
  "/api/quote",
  "/api/bookings",
];

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0].use.baseURL;
  for (const path of PATHS) {
    try {
      await fetch(`${baseURL}${path}`, { redirect: "manual" });
    } catch {
      // A page that fails to load will fail its own test with a clearer message.
    }
  }
}
