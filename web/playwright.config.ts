import { defineConfig } from "@playwright/test";

/**
 * A second run in the same checkout must not share a port, a database, a
 * build folder or a results folder with the first: two processes writing one
 * build folder corrupt it. `E2E_NAME=tester E2E_PORT=3213 npm run test:e2e`
 * gives a run its own of each. The name can only ever extend "e2e", so the
 * clean-up below cannot reach local development data.
 */
const SUFFIX = /^[a-z0-9]{1,20}$/.test(process.env.E2E_NAME ?? "") ? `-${process.env.E2E_NAME}` : "";
const NAME = `e2e${SUFFIX}`;
const PORT = Number(process.env.E2E_PORT) || 3211;

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
  outputDir: `test-results${SUFFIX}`,
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
    command: `rm -rf .data/${NAME} .next-${NAME} && npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/api/booking-config`,
    // Set E2E_REUSE_SERVER=1 to run against a server you started yourself
    // (same port and environment). Its database must be fresh.
    reuseExistingServer: Boolean(process.env.E2E_REUSE_SERVER),
    timeout: 180_000,
    env: {
      PGLITE_DATA_NAME: NAME,
      NEXT_DIST_DIR: `.next-${NAME}`,
      // Three owners: sign-in codes are limited to three per address in 15 minutes.
      OWNER_EMAILS: "owner@studio.test,owner2@studio.test,owner3@studio.test",
      // The whole suite books from one address, more often than the ten times a minute a visitor is allowed.
      BOOKING_REQUESTS_PER_MINUTE: "200",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
