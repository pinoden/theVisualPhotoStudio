import type { MetadataRoute } from "next";
import { getCatalog } from "@/server/cached";
import { sessionsOf } from "@/lib/domain/services";
import { getDb } from "@/db/client";
import { listedPages } from "@/server/pages";
import { siteUrl } from "@/server/runtime";

/** The public pages written in the site's code: the booking steps. Content creation's once a session is on sale. */
const BUILT_IN = ["/book", "/book/photography"];

/**
 * /sitemap.xml: every page a search engine may list. The pages of the admin,
 * the home page among them, are listed while they are published, unless they
 * are marked as hidden from search engines.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = await siteUrl();
  const made = await listedPages(await getDb());
  const content = sessionsOf((await getCatalog()).photoPackages, "content").length > 0 ? ["/book/content"] : [];
  return [
    ...made.map((page) => ({ url: `${base}${page.path === "/" ? "" : page.path}`, ...(page.publishedAt ? { lastModified: page.publishedAt } : {}) })),
    ...[...BUILT_IN, ...content].map((path) => ({ url: `${base}${path}` })),
  ];
}
