import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { DesignEditor } from "@/components/site-editor/DesignEditor";
import { getDb } from "@/db/client";
import { requireManager } from "@/server/session";
import { loadSettings } from "@/server/settings";
import { DESIGN_DOC, listVersions, loadForEditing } from "@/server/website";
import { AdminFrame, AdminLoading } from "../../frame";

export const metadata: Metadata = { title: "Website design", robots: { index: false } };

export default function DesignPage(props: PageProps<"/admin/website/design">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <DesignPageBody searchParams={props.searchParams} />
    </Suspense>
  );
}

/** The design editor, for an owner or a manager who may change the website. Anyone else gets "not found". */
async function DesignPageBody({ searchParams }: Pick<PageProps<"/admin/website/design">, "searchParams">) {
  await connection();
  const viewer = await requireManager("/admin/website/design");
  const db = await getDb();
  const [state, versions, settings] = await Promise.all([loadForEditing(db, viewer, DESIGN_DOC), listVersions(db, viewer, DESIGN_DOC), loadSettings(db)]);
  if (!state || !versions) notFound();
  return (
    <AdminFrame active="/admin/website" title="Design" query={await searchParams} viewer={viewer} settings={settings}>
      <p style={{ margin: "-1rem 0 1.5rem", fontSize: ".85rem" }}>
        <Link href="/admin/website">← Website</Link>
      </p>
      <DesignEditor initial={state} versions={versions} />
    </AdminFrame>
  );
}
