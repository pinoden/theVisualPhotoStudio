import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { PageBlocks } from "@/components/site/PageBlocks";
import { getRedirect } from "@/server/cached";
import { sitePage } from "@/server/site";

/**
 * A page made in the admin (Admin, Website, Pages), at its own address. The
 * site's own pages (booking, account, admin, and the public pages still
 * written in code) have routes of their own, which Next.js tries first: this
 * route only gets addresses none of them has.
 *
 * What is published is cached and shown to everyone; in a preview the page's
 * draft is shown instead (src/server/site.ts). An address that is no page is
 * looked up among the old addresses and sent on with a permanent redirect,
 * or answered "not found".
 *
 * With Cache Components a dynamic route needs at least one sample address to
 * be checked when the site is built. This one can never be a page (an
 * address has no underscores), so it checks the "not found" path. Other
 * addresses are rendered when first asked for, before any of the page is
 * sent, which is what lets a redirect and "not found" answer with their own
 * status codes.
 */
export async function generateStaticParams() {
  return [{ slug: ["__sample__"] }];
}

/**
 * A navigation to this route waits for the page to be found, by design: an
 * address that is no page has to answer with a redirect or "not found"
 * before anything is shown. So it is not checked for instant navigation.
 */
export const instant = false;

const pathOf = async (params: PageProps<"/[...slug]">["params"]) => (await params).slug.join("/");

export async function generateMetadata({ params }: PageProps<"/[...slug]">): Promise<Metadata> {
  const page = await sitePage(await pathOf(params));
  if (!page) return {};
  const { meta } = page.content;
  return {
    // A title written for search engines is used as it is; otherwise the page's name, then the studio's.
    title: meta.title ? { absolute: meta.title } : page.title,
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.hidden ? { robots: { index: false } } : {}),
  };
}

export default async function ContentPage({ params }: PageProps<"/[...slug]">) {
  const path = await pathOf(params);
  const page = await sitePage(path);
  if (!page) {
    const to = await getRedirect(`/${path}`);
    if (to) permanentRedirect(to);
    notFound();
  }
  return (
    <div className="site-page blk-root">
      <PageBlocks blocks={page.content.blocks} site={page.site} />
    </div>
  );
}
