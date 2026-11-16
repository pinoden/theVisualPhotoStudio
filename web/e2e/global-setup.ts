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
  "/admin/settings",
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
  "/dev/outbox",
  "/booking/VS-AAAAAA?t=warm-up-warm-up-warm-up",
  "/api/availability?date=2030-01-09",
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
