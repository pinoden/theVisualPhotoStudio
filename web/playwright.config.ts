import { defineConfig } from "@playwright/test";

const PORT = 3211;

/**
 * Browser tests. They start their own dev server with a throwaway database
 * in .data/e2e, the pretend card processor and no email service, so they
 * never touch local development data and never move money.
 * Run with `npm run test:e2e`.
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  // One database shared by every test: run them in order, one at a time.
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    // Start from an empty database and an empty build folder every time. A
    // build cache left by a server that was killed mid-write makes every
    // page reload in a loop.
    command: `rm -rf .data/e2e .next-e2e && npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/api/booking-config`,
    // Set E2E_REUSE_SERVER=1 to run against a server you started yourself
    // (same port and environment). Its database must be fresh.
    reuseExistingServer: Boolean(process.env.E2E_REUSE_SERVER),
    timeout: 180_000,
    env: {
      PGLITE_DATA_NAME: "e2e",
      NEXT_DIST_DIR: ".next-e2e",
      // Two owners: sign-in codes are limited to three per address in 15 minutes.
      OWNER_EMAILS: "owner@studio.test,owner2@studio.test",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
