import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageEditorLoader } from "@/components/site-editor/PageEditorLoader";
import { getDb } from "@/db/client";
import { CONDITIONS, type ConditionName } from "@/lib/site/conditions";
import { liveValues } from "@/lib/site/live-values";
import { listInWords } from "@/lib/words";
import { PAGE_LIMITS } from "@/lib/site/page";
import { linkablePages, linksToPage, listPageVersions, loadPageForEditing, pageEditorContext, TRASH_DAYS } from "@/server/pages";
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
  // Where the website links here: those links answer "not found" once the page is off the website.
  const leadingHere = state.home || !state.isLive ? [] : await linksToPage(db, state.id);
  const linksWarning = leadingHere.length > 0 && (
    <p className="notice notice-warning">
      Links lead here from {listInWords(leadingHere)}. Once this page is off the website they answer &ldquo;not found&rdquo;:
      change them as well.
    </p>
  );

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
          builtIn: state.builtIn,
        }}
        versions={versions ?? []}
        collections={context.collections}
        links={links.filter((link) => link.path !== state.path)}
        fontClasses={FONT_CLASSES}
      />

      {context.site.values && (
        <details className="admin-card live-values" id="live-values">
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

      {context.site.conditions && (
        <details className="admin-card live-values" id="page-conditions">
          <summary>Shown only at times: what follows what the studio offers</summary>
          <p className="editor-hint">
            Start a paragraph, a list item, a heading or a quote with <code>{"{if pets}"}</code> and visitors see it only
            while pets can come; <code>{"{if not pets}"}</code> does the opposite. The same works at the start of a
            question, a card&rsquo;s title, a button&rsquo;s words and a row of a table. A whole block has a &ldquo;Show
            it&rdquo; choice of its own, at the end of its fields. The editor shows everything; Preview shows the page as
            visitors see it now.
          </p>
          <table className="price-table">
            <tbody>
              {(Object.keys(CONDITIONS) as ConditionName[]).map((name) => (
                <tr key={name}>
                  <td>
                    <code>{`{if ${name}}`}</code>
                    <br />
                    <span className="editor-hint">While {CONDITIONS[name].yes}</span>
                  </td>
                  <td>{context.site.conditions?.[name] ? "Shown now" : "Not shown now"}</td>
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
          {!state.home && (
            <div className="form-group" style={{ flex: "2 1 14rem" }}>
              <label className="form-label" htmlFor="page-address">
                Address
              </label>
              <input id="page-address" name="slug" className="form-control" maxLength={PAGE_LIMITS.slug} defaultValue={state.slug} required pattern="[A-Za-z0-9\/\-]+" title="Small letters, digits and hyphens: gift-cards, or studios/decor" />
            </div>
          )}
          <button type="submit" className="btn btn-dark btn-small">
            Save
          </button>
        </div>
        <p className="editor-hint">
          {state.home
            ? "The name changes at once, without a draft. The home page is the website's own address, /, and keeps it."
            : "These change at once, without a draft. When a page that is on the website gets a new address, its old address keeps working: it leads to the new one."}
        </p>
      </form>

      {state.isLive && state.may.publish && !state.home && (
        <form action={unpublishPageAction} className="admin-card">
          <h3>Take it off the website</h3>
          <input type="hidden" name="id" value={state.id} />
          <p className="editor-hint" style={{ margin: "0 0 1rem" }}>
            Visitors can no longer open it. It stays here as a draft, with everything on it, to publish again later.
          </p>
          {linksWarning}
          <button type="submit" className="btn btn-outline btn-small">
            Take {state.title} off the website
          </button>
        </form>
      )}

      {(!state.isLive || state.may.publish) && !state.home && (
        <details className="admin-card media-delete">
          <summary>Delete this page</summary>
          <form action={deletePageAction}>
            <input type="hidden" name="id" value={state.id} />
            <p className="editor-hint">
              {state.builtIn
                ? "It goes to the trash, under Pages, and can be brought back from there at any time: a page the website was built with is never removed from it."
                : `It goes to the trash, under Pages, and can be brought back for ${TRASH_DAYS} days.`}
            </p>
            {linksWarning}
            <button type="submit" className="btn btn-outline btn-small">
              Yes, delete {state.title}
            </button>
          </form>
        </details>
      )}
    </AdminFrame>
  );
}
