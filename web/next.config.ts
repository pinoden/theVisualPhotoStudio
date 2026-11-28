import type { NextConfig } from "next";

/**
 * Sent with every response (the security review of 2026-11-19). The site's own pages may frame it (the page editor's
 * preview), no other site may. A full content security policy is not set yet: Square's card form and the framework's
 * own inline scripts need careful allowances, to be tried on the preview first.
 */
const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      // The hosted preview's own addresses (*.vercel.app) are kept out of search engines: until the studio's domain
      // points here, the same pages there would compete with the live website, and afterwards with the domain itself.
      // The studio's own domain is unaffected.
      { source: "/:path*", has: [{ type: "host", value: "(?<host>.*)\\.vercel\\.app" }], headers: [{ key: "X-Robots-Tag", value: "noindex" }] },
    ];
  },
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
