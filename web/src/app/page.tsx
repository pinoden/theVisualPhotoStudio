import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageBlocks } from "@/components/site/PageBlocks";
import { jsonLd, localBusiness } from "@/lib/site/structured-data";
import { getCatalog } from "@/server/cached";
import { configuredSiteUrl } from "@/server/runtime";
import { shareMetadata, sharePicture, siteFrame, sitePage } from "@/server/site";

/**
 * The home page: the page of the admin whose address is "/" (Admin, Website,
 * Pages, "Home"), which the website was built with and which cannot move or
 * leave the website (src/server/pages.ts). The other pages are drawn by the
 * route for any address, `[...slug]`; this one has a route of its own
 * because that route cannot answer the website's own address.
 */

export async function generateMetadata(): Promise<Metadata> {
  const [page, { frame }] = await Promise.all([sitePage(""), siteFrame()]);
  if (!page) return {};
  const { meta } = page.content;
  // Without a title of its own, the home page has the website's title, as the owners set it for search engines.
  return {
    ...(meta.title ? { title: { absolute: meta.title } } : {}),
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.hidden ? { robots: { index: false } } : {}),
    ...(await shareMetadata({ title: meta.title || frame.search.title, description: meta.description || frame.search.description, path: "/" })),
  };
}

export default async function HomePage() {
  const page = await sitePage("");
  if (!page) notFound();
  const [{ frame }, catalog, picture] = await Promise.all([siteFrame(), getCatalog(), sharePicture()]);
  const site = configuredSiteUrl();
  // The studio as a business, for maps and local search results (src/lib/site/structured-data.ts).
  const business = localBusiness({ business: frame.business, catalog, url: site, image: picture && site ? `${site}${picture.url}` : null });
  return (
    <div className="site-page blk-root">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(business) }} />
      <PageBlocks blocks={page.content.blocks} site={page.site} />
    </div>
  );
}
