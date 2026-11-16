import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { FrameEditor } from "@/components/site-editor/FrameEditor";
import { getDb } from "@/db/client";
import { listMedia } from "@/server/media";
import { linkablePages } from "@/server/pages";
import { requireManager } from "@/server/session";
import { loadSettings } from "@/server/settings";
import { FRAME_DOC, listVersions, loadForEditing } from "@/server/website";
import { AdminFrame, AdminLoading } from "../../frame";
import { WebsiteTabs } from "../tabs";

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
  const pages = await linkablePages(db);
  // The editor shows the logo's picture and the sharing picture, of which the frame only holds the ids.
  const named = [state.content.logo.image, state.content.search.image].filter((id) => id !== "");
  const library = named.length > 0 ? ((await listMedia(db, viewer)) ?? []) : [];
  const choosable = library
    .filter((item) => named.includes(item.id))
    .map((item) => ({ id: item.id, url: item.url, width: item.width, height: item.height, alt: item.alt, caption: item.caption, filename: item.filename }));
  return (
    <AdminFrame active="/admin/website" title="Header, menu & footer" query={await searchParams} viewer={viewer} settings={settings}>
      <WebsiteTabs active="/admin/website/navigation" viewer={viewer} />
      <FrameEditor
        initial={state}
        versions={versions}
        pictures={choosable}
        pages={pages}
      />
    </AdminFrame>
  );
}
