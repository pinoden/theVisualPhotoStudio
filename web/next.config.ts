import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Database drivers load native/WASM files at runtime and must not be bundled.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  // The browser tests build into their own folder (NEXT_DIST_DIR=.next-e2e), so
  // they can run while `npm run dev` or `npm run build` is using .next. Two
  // processes sharing one build folder corrupt its cache and every page then
  // reloads in a loop.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
