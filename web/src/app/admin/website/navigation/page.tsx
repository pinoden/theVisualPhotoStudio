import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { FrameEditor } from "@/components/site-editor/FrameEditor";
import { getDb } from "@/db/client";
import { requireManager } from "@/server/session";
import { loadSettings } from "@/server/settings";
import { FRAME_DOC, listVersions, loadForEditing } from "@/server/website";
import { AdminFrame, AdminLoading } from "../../frame";

export const metadata: Metadata = { title: "Header, menu & footer", robots: { index: false } };

export default function NavigationPage(props: PageProps<"/admin/website/navigation">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <NavigationPageBody searchParams={props.searchParams} />
    </Suspense>
  );
}

/** The editor of the header, menu and footer, for an owner or a manager who may change the website. Anyone else gets "not found". */
async function NavigationPageBody({ searchParams }: Pick<PageProps<"/admin/website/navigation">, "searchParams">) {
  await connection();
  const viewer = await requireManager("/admin/website/navigation");
  const db = await getDb();
  const [state, versions, settings] = await Promise.all([loadForEditing(db, viewer, FRAME_DOC), listVersions(db, viewer, FRAME_DOC), loadSettings(db)]);
  if (!state || !versions) notFound();
  return (
    <AdminFrame active="/admin/website" title="Header, menu & footer" query={await searchParams} viewer={viewer} settings={settings}>
      <p style={{ margin: "-1rem 0 1.5rem", fontSize: ".85rem" }}>
        <Link href="/admin/website">← Website</Link>
      </p>
      <FrameEditor initial={state} versions={versions} />
    </AdminFrame>
  );
}
