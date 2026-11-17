import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageBlocks } from "@/components/site/PageBlocks";
import { getDb } from "@/db/client";
import { loadPageForEditing, loadPublishedPage } from "@/server/pages";
import { requireManager } from "@/server/session";

export const metadata: Metadata = { title: "Phone check", robots: { index: false } };

/**
 * A page's draft drawn as visitors would get it, for the phone checks the
 * page editor runs before it publishes (src/components/site-editor/phone-check.ts).
 * The editor loads it out of sight at a phone's width and measures it. With
 * `?as=published` it draws the page as visitors have it now (nothing, for a
 * page not published), to tell what a change brings from what was there
 * before it. For whoever may edit the page; anyone else gets "not found".
 */
export default function PhoneCheckPage(props: PageProps<"/admin/website/pages/[id]/check">) {
  return (
    <Suspense fallback={null}>
      <Check params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Check({ params, searchParams }: Pick<PageProps<"/admin/website/pages/[id]/check">, "params" | "searchParams">) {
  await connection();
  const { id } = await params;
  const viewer = await requireManager(`/admin/website/pages/${encodeURIComponent(id)}`);
  const db = await getDb();
  const now = new Date();
  const state = await loadPageForEditing(db, viewer, id, now);
  if (!state) notFound();
  const shown = (await searchParams).as === "published" ? await loadPublishedPage(db, state.slug, now) : { content: state.content, site: state.site };
  return (
    <div className="site-page blk-root" data-phone-check={state.revision}>
      {shown && <PageBlocks blocks={shown.content.blocks} site={shown.site} />}
    </div>
  );
}
