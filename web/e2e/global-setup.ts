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
  "/book",
  "/account/sign-in",
  "/account",
  "/staff",
  "/admin",
  "/admin/bookings",
  "/admin/staff",
  "/admin/prices",
  "/admin/hours",
  "/admin/codes",
  "/admin/settings",
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
