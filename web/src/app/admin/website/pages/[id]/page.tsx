import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageEditorLoader } from "@/components/site-editor/PageEditorLoader";
import { getDb } from "@/db/client";
import { liveValues } from "@/lib/site/live-values";
import { PAGE_LIMITS } from "@/lib/site/page";
import { linkablePages, listPageVersions, loadPageForEditing, pageEditorContext } from "@/server/pages";
import { requireManager } from "@/server/session";
import { loadSettings } from "@/server/settings";
import { FONT_CLASSES } from "../../../../fonts";
import { AdminFrame, AdminLoading } from "../../../frame";
import { WebsiteTabs } from "../../tabs";
import { deletePageAction, savePageSettingsAction, unpublishPageAction } from "../actions";

export const metadata: Metadata = { title: "Edit a page", robots: { index: false } };

export default function EditPagePage(props: PageProps<"/admin/website/pages/[id]">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <EditPage params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

/** One page: the editor, then its name and address, taking it off the website, and deleting it. */
async function EditPage({ params, searchParams }: Pick<PageProps<"/admin/website/pages/[id]">, "params" | "searchParams">) {
  await connection();
  const { id } = await params;
  const viewer = await requireManager(`/admin/website/pages/${encodeURIComponent(id)}`);
  const db = await getDb();
  const now = new Date();
  const state = await loadPageForEditing(db, viewer, id, now);
  if (!state) notFound();
  const [versions, context, links, settings] = await Promise.all([listPageVersions(db, viewer, id), pageEditorContext(db, state.content, now), linkablePages(db), loadSettings(db)]);
  const liveValueList = context.site.catalog && context.site.business ? liveValues(context.site.catalog, context.site.business) : [];

  return (
    <AdminFrame active="/admin/website" title={state.title} query={await searchParams} viewer={viewer} settings={settings} wide>
      <WebsiteTabs active="/admin/website/pages" viewer={viewer} />
      <p className="page-editor-where">
        <Link href="/admin/website/pages">← All pages</Link> · {state.isLive ? <a href={state.path}>{state.path}</a> : state.path} ·{" "}
        {state.isLive ? (state.hasDraft ? "On the website, with changes not published" : "On the website") : "Draft: not on the website"}
      </p>

      <PageEditorLoader
        initial={{
          id: state.id,
          title: state.title,
          path: state.path,
          isLive: state.isLive,
          content: state.content,
          hasDraft: state.hasDraft,
          revision: state.revision,
          draftAt: state.draftAt,
          may: state.may,
          site: context.site,
        }}
        versions={versions ?? []}
        collections={context.collections}
        links={links.filter((link) => link.path !== state.path)}
        fontClasses={FONT_CLASSES}
      />

      {context.site.values && (
        <details className="admin-card live-values">
          <summary>Live values: facts from the settings that any text can show</summary>
          <p className="editor-hint">
            Type a name between braces into any text, for example <code>{"{refund window}"}</code>. The editor shows the
            name; the website shows the value, and follows the settings and prices when they change.
          </p>
          <table className="price-table">
            <tbody>
              {liveValueList.map((entry) => (
                <tr key={entry.name}>
                  <td>
                    <code>{`{${entry.name}}`}</code>
                    <br />
                    <span className="editor-hint">{entry.about}</span>
                  </td>
                  <td>{entry.value || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      <form action={savePageSettingsAction} className="admin-card">
        <h3>Name and address</h3>
        <input type="hidden" name="id" value={state.id} />
        <div className="admin-form-row">
          <div className="form-group" style={{ flex: "2 1 14rem" }}>
            <label className="form-label" htmlFor="page-name">
              Name
            </label>
            <input id="page-name" name="title" className="form-control" maxLength={PAGE_LIMITS.title} defaultValue={state.title} required />
          </div>
          <div className="form-group" style={{ flex: "2 1 14rem" }}>
            <label className="form-label" htmlFor="page-address">
              Address
            </label>
            <input id="page-address" name="slug" className="form-control" maxLength={PAGE_LIMITS.slug} defaultValue={state.slug} required pattern="[A-Za-z0-9\/\-]+" title="Small letters, digits and hyphens: gift-cards, or studios/decor" />
          </div>
          <button type="submit" className="btn btn-dark btn-small">
            Save
          </button>
        </div>
        <p className="editor-hint">
          These change at once, without a draft. When a page that is on the website gets a new address, its old address
          keeps working: it leads to the new one.
        </p>
      </form>

      {state.isLive && state.may.publish && (
        <form action={unpublishPageAction} className="admin-card">
          <h3>Take it off the website</h3>
          <input type="hidden" name="id" value={state.id} />
          <p className="editor-hint" style={{ margin: "0 0 1rem" }}>
            Visitors can no longer open it. It stays here as a draft, with everything on it, to publish again later.
          </p>
          <button type="submit" className="btn btn-outline btn-small">
            Take {state.title} off the website
          </button>
        </form>
      )}

      {(!state.isLive || state.may.publish) && (
        <details className="admin-card media-delete">
          <summary>Delete this page</summary>
          <form action={deletePageAction}>
            <input type="hidden" name="id" value={state.id} />
            <p className="editor-hint">It goes to the trash, under Pages, and can be brought back for 30 days.</p>
            <button type="submit" className="btn btn-outline btn-small">
              Yes, delete {state.title}
            </button>
          </form>
        </details>
      )}
    </AdminFrame>
  );
}
