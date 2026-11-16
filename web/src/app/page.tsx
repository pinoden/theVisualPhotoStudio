import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageBlocks } from "@/components/site/PageBlocks";
import { sitePage } from "@/server/site";

/**
 * The home page: the page of the admin whose address is "/" (Admin, Website,
 * Pages, "Home"), which the website was built with and which cannot move or
 * leave the website (src/server/pages.ts). The other pages are drawn by the
 * route for any address, `[...slug]`; this one has a route of its own
 * because that route cannot answer the website's own address.
 */

export async function generateMetadata(): Promise<Metadata> {
  const page = await sitePage("");
  if (!page) return {};
  const { meta } = page.content;
  // Without a title of its own, the home page has the website's title, as the owners set it for search engines.
  return {
    ...(meta.title ? { title: { absolute: meta.title } } : {}),
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.hidden ? { robots: { index: false } } : {}),
  };
}

export default async function HomePage() {
  const page = await sitePage("");
  if (!page) notFound();
  return (
    <div className="site-page blk-root">
      <PageBlocks blocks={page.content.blocks} site={page.site} />
    </div>
  );
}
