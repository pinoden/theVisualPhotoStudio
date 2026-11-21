import { describe, expect, it } from "vitest";
import { mayUseTestTools } from "./browser-test-server";

/** The browser tests' server for a production build, as playwright.config.ts starts it. */
const TEST_SERVER = {
  NODE_ENV: "production",
  BROWSER_TEST_SERVER: "1",
  DATABASE_URL: "",
  ALLOW_PGLITE_IN_PRODUCTION: "1",
  PAYMENTS_MODE: "mock",
};

describe("mayUseTestTools", () => {
  it("allows the tools in development and in tests", () => {
    expect(mayUseTestTools({ NODE_ENV: "development" })).toBe(true);
    expect(mayUseTestTools({ NODE_ENV: "test" })).toBe(true);
  });

  it("refuses them in production", () => {
    expect(mayUseTestTools({ NODE_ENV: "production" })).toBe(false);
    expect(mayUseTestTools({ NODE_ENV: "production", BROWSER_TEST_SERVER: "1" })).toBe(false);
  });

  it("allows them on the browser tests' own production server", () => {
    expect(mayUseTestTools(TEST_SERVER)).toBe(true);
  });

  it("refuses them on a production server that could be a live site, even with the tests' flag", () => {
    expect(mayUseTestTools({ ...TEST_SERVER, DATABASE_URL: "postgres://db.example/site" })).toBe(false);
    expect(mayUseTestTools({ ...TEST_SERVER, ALLOW_PGLITE_IN_PRODUCTION: undefined })).toBe(false);
    expect(mayUseTestTools({ ...TEST_SERVER, PAYMENTS_MODE: undefined })).toBe(false);
    expect(mayUseTestTools({ ...TEST_SERVER, PAYMENTS_MODE: "square" })).toBe(false);
    expect(mayUseTestTools({ ...TEST_SERVER, RESEND_API_KEY: "re_key" })).toBe(false);
    expect(mayUseTestTools({ ...TEST_SERVER, BROWSER_TEST_SERVER: "true" })).toBe(false);
  });
});
