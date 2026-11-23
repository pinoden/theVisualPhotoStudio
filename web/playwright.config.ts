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
 * `E2E_BUILD=1` runs the tests against a production build in place of the development server: `next build`, then the
 * build served over HTTPS (e2e/https-server.mjs), as the host serves the site. A production server offers the tests'
 * tools (the outbox, the raised limits) only when it is theirs beyond doubt (`mayUseTestTools`,
 * src/server/browser-test-server.ts), and the variables below make it so.
 */
const BUILD = process.env.E2E_BUILD === "1";
const ORIGIN = `${BUILD ? "https" : "http"}://localhost:${PORT}`;
// The production build's certificate, for localhost, made for each run and trusted by its server (e2e/https-server.mjs).
const TLS = `.data/${NAME}-tls`;
const CERTIFICATE =
  `mkdir -p ${TLS} && openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=localhost ` +
  `-addext subjectAltName=DNS:localhost -keyout ${TLS}/key.pem -out ${TLS}/cert.pem 2>/dev/null`;
// The database is made before the build, which prerenders from a copy of it (scripts/e2e-database.ts).
const SNAPSHOT = `.data/${NAME}.tar.gz`;

/**
 * Browser tests. They start their own server with a throwaway database
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
  // No retries, in CI either. Playwright retries a serial file from its first test, on the database the failed try
  // left, and those files sign in with several owner addresses three times each, the most the site allows in 15
  // minutes: the second pass is refused a code. A failed CI job is read, then run again by hand (AGENTS.md).
  retries: 0,
  // A `test.only` left in a file would make CI run that one test, and pass.
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"]],
  outputDir: `test-results${SUFFIX}`,
  use: {
    baseURL: ORIGIN,
    // The production build's certificate is made for the run (e2e/https-server.mjs).
    ignoreHTTPSErrors: BUILD,
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    // Start from an empty database and an empty build folder every time. A
    // build cache left by a server that was killed mid-write makes every
    // page reload in a loop.
    command: BUILD
      ? `rm -rf .data/${NAME} ${SNAPSHOT} ${TLS} .next-${NAME} && ${CERTIFICATE} && ` +
        `PGLITE_BUILD_SNAPSHOT=${SNAPSHOT} npx tsx scripts/e2e-database.ts && PGLITE_BUILD_SNAPSHOT=${SNAPSHOT} npx next build && ` +
        `NODE_ENV=production PORT=${PORT} TLS_DIR=${TLS} NODE_EXTRA_CA_CERTS=${TLS}/cert.pem node e2e/https-server.mjs`
      : `rm -rf .data/${NAME} .next-${NAME} && npx next dev -p ${PORT}`,
    url: `${ORIGIN}/api/booking-config`,
    ignoreHTTPSErrors: BUILD,
    // Set E2E_REUSE_SERVER=1 to run against a server you started yourself
    // (same port and environment). Its database must be fresh.
    reuseExistingServer: Boolean(process.env.E2E_REUSE_SERVER),
    // A production build is made first, in a few minutes.
    timeout: BUILD ? 600_000 : 180_000,
    env: {
      // Never a real database, whatever web/.env.local says (`neon link` writes a staging DATABASE_URL there): Next.js
      // does not override a variable that is already set, so an empty one keeps the embedded database below.
      DATABASE_URL: "",
      // Never a real email service either, whatever the shell has.
      RESEND_API_KEY: "",
      PGLITE_DATA_NAME: NAME,
      // The site's own address, as production has it: the addresses in pages' metadata and emails are made with it.
      SITE_URL: ORIGIN,
      NEXT_DIST_DIR: `.next-${NAME}`,
      // A production build would refuse the embedded database and take real cards: these make its server the tests'.
      ...(BUILD ? { BROWSER_TEST_SERVER: "1", ALLOW_PGLITE_IN_PRODUCTION: "1", PAYMENTS_MODE: "mock" } : {}),
      // Thirteen owners: sign-in codes are limited to three per address in 15 minutes. The fourth is for
      // z-mobile.spec.ts, the fifth for the customers test of site.spec.ts, the sixth to tenth for website.spec.ts,
      // the eleventh for a11y.spec.ts, the twelfth for z-mobile.spec.ts's iPad, the thirteenth for the emails test of
      // site.spec.ts.
      OWNER_EMAILS:
        "owner@studio.test,owner2@studio.test,owner3@studio.test,owner4@studio.test,owner5@studio.test,owner6@studio.test,owner7@studio.test,owner8@studio.test,owner9@studio.test,owner10@studio.test,owner11@studio.test,owner12@studio.test,owner13@studio.test,owner14@studio.test,owner15@studio.test,owner16@studio.test",
      // The whole suite books from one address, more often than the ten times a minute a visitor is allowed.
      BOOKING_REQUESTS_PER_MINUTE: "200",
      // And signs in more often than the ten codes and thirty tries a quarter of an hour one address is allowed.
      SIGN_IN_REQUESTS_PER_IP: "500",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
