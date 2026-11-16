import type { MetadataRoute } from "next";
import { siteUrl } from "@/server/runtime";

/**
 * /robots.txt: search engines may list the public website, and are asked to
 * keep out of the admin, the accounts, the private booking and payment pages
 * and the site's own addresses.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const base = await siteUrl();
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/admin", "/account", "/staff", "/booking/", "/pay/", "/dev", "/api/"] }],
    sitemap: `${base}/sitemap.xml`,
  };
}
