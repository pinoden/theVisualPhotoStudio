import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageBlocks } from "@/components/site/PageBlocks";
import { getDb } from "@/db/client";
import { loadPageForEditing } from "@/server/pages";
import { requireManager } from "@/server/session";

export const metadata: Metadata = { title: "Phone check", robots: { index: false } };

/**
 * A page's draft drawn as visitors would get it, for the phone checks the
 * page editor runs before it publishes (src/components/site-editor/phone-check.ts).
 * The editor loads it out of sight at a phone's width and measures it. For
 * whoever may edit the page; anyone else gets "not found".
 */
export default function PhoneCheckPage(props: PageProps<"/admin/website/pages/[id]/check">) {
  return (
    <Suspense fallback={null}>
      <Check params={props.params} />
    </Suspense>
  );
}

async function Check({ params }: Pick<PageProps<"/admin/website/pages/[id]/check">, "params">) {
  await connection();
  const { id } = await params;
  const viewer = await requireManager(`/admin/website/pages/${encodeURIComponent(id)}`);
  const state = await loadPageForEditing(await getDb(), viewer, id, new Date());
  if (!state) notFound();
  return (
    <div className="site-page blk-root" data-phone-check={state.revision}>
      <PageBlocks blocks={state.content.blocks} site={state.site} />
    </div>
  );
}
