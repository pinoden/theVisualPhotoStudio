type Env = Readonly<Record<string, string | undefined>>;

/**
 * Whether this server may offer the tools the browser tests use: the outbox at /dev/outbox, which shows every email
 * and so every sign-in code, its task runner, the raised request limits, and the email log in place of a service.
 *
 * In development, always. In production, only on the browser tests' own server for a production build (`E2E_BUILD=1`
 * in playwright.config.ts), and only when everything about the server says it is one: the tests' flag, the embedded
 * database (a live site has a database address), the pretend card processor and no email service. With any one of
 * them missing it is a production server like any other.
 */
export function mayUseTestTools(env: Env = process.env): boolean {
  if (env.NODE_ENV !== "production") return true;
  return (
    env.BROWSER_TEST_SERVER === "1" &&
    !env.DATABASE_URL &&
    env.ALLOW_PGLITE_IN_PRODUCTION === "1" &&
    env.PAYMENTS_MODE === "mock" &&
    !env.RESEND_API_KEY
  );
}
