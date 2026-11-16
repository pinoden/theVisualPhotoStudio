import type { MetadataRoute } from "next";
import { getDb } from "@/db/client";
import { listedPages } from "@/server/pages";
import { siteUrl } from "@/server/runtime";

/** The public pages written in the site's code. */
const BUILT_IN = ["/", "/studios", "/rates", "/services", "/faq", "/policies", "/contact", "/book", "/book/photography"];

/**
 * /sitemap.xml: every page a search engine may list. The pages made in the
 * admin are listed once they are published, unless they are marked as hidden
 * from search engines.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = await siteUrl();
  const made = await listedPages(await getDb());
  return [
    ...BUILT_IN.map((path) => ({ url: `${base}${path === "/" ? "" : path}` })),
    ...made.map((page) => ({ url: `${base}${page.path}`, ...(page.publishedAt ? { lastModified: page.publishedAt } : {}) })),
  ];
}
