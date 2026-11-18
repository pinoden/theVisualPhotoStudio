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
  images: {
    // The only pictures the site resizes are those of the media library, at their own addresses
    // (/media/<id>/<version>/<name>, src/server/media.ts), never with anything after a question mark.
    localPatterns: [{ pathname: "/media/**", search: "" }],
    qualities: [75, 85],
  },
};

export default nextConfig;
