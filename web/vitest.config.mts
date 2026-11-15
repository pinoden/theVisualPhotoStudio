import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    // Server and domain tests run in Node. Component tests opt into a
    // simulated browser with a `// @vitest-environment jsdom` comment.
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    // Each integration test file starts its own in-memory Postgres.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
