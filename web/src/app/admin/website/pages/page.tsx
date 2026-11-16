import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { PAGE_LIMITS } from "@/lib/site/page";
import { listPages, listRedirects, listTrash, TRASH_DAYS, type PageSummary } from "@/server/pages";
import { requireManager } from "@/server/session";
import { loadSettings } from "@/server/settings";
import { formatInstant } from "@/server/tz";
import { websiteAbilities } from "@/server/website";
import { AdminFrame, AdminLoading } from "../../frame";
import { WebsiteTabs } from "../tabs";
import { addRedirectAction, createPageAction, duplicatePageAction, removeRedirectAction, restorePageAction } from "./actions";

export const metadata: Metadata = { title: "Pages", robots: { index: false } };

export default function PagesPage(props: PageProps<"/admin/website/pages">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Pages searchParams={props.searchParams} />
    </Suspense>
  );
}

const STATE: Record<PageSummary["state"], string> = {
  draft: "Draft: not on the website",
  live: "On the website",
  changed: "On the website, with changes not published",
};

/**
 * The pages made in the admin: the list, a new page, the trash and the old
 * addresses. For an owner, or a manager who may edit pages. Anyone else gets
 * "not found".
 */
async function Pages({ searchParams }: Pick<PageProps<"/admin/website/pages">, "searchParams">) {
  await connection();
  const viewer = await requireManager("/admin/website/pages");
  const db = await getDb();
  const [pages, trash, redirects, settings, may] = await Promise.all([listPages(db, viewer), listTrash(db, viewer), listRedirects(db, viewer), loadSettings(db), websiteAbilities(db, viewer)]);
  if (!pages || !trash || !redirects) notFound();

  return (
    <AdminFrame active="/admin/website" title="Pages" query={await searchParams} viewer={viewer} settings={settings}>
      <WebsiteTabs active="/admin/website/pages" viewer={viewer} />
      <div className="admin-card">
        <p style={{ margin: 0, fontSize: ".9rem" }}>
          A page is made of blocks: sections, columns, headings, text, pictures, galleries, videos, buttons. A new page
          is a draft; it is on the website once it is published. The home page, the studios, rates, photography,
          guest information, policies and contact pages are still part of the site itself, and are not listed here
          yet.
        </p>
      </div>

      <form action={createPageAction} className="admin-card admin-form-row">
        <div className="form-group" style={{ flex: "2 1 14rem" }}>
          <label className="form-label" htmlFor="page-title">
            Name of a new page
          </label>
          <input id="page-title" name="title" className="form-control" maxLength={PAGE_LIMITS.title} required />
        </div>
        <div className="form-group" style={{ flex: "2 1 14rem" }}>
          <label className="form-label" htmlFor="page-slug">
            Its address (optional)
          </label>
          <input id="page-slug" name="slug" className="form-control" maxLength={PAGE_LIMITS.slug} placeholder="made from the name" pattern="[A-Za-z0-9\/\-]*" title="Small letters, digits and hyphens: gift-cards, or studios/decor" />
        </div>
        <button type="submit" className="btn btn-dark btn-small">
          Make the page
        </button>
      </form>

      {pages.length === 0 ? (
        <div className="admin-card">
          <p style={{ margin: 0 }}>No pages made yet.</p>
        </div>
      ) : (
        <ul className="page-list">
          {pages.map((page) => (
            <li key={page.id} className="admin-card">
              <div>
                <h3>
                  <Link href={`/admin/website/pages/${page.id}`}>{page.title}</Link>
                </h3>
                <p className="media-facts">
                  {page.state === "draft" ? page.path : <a href={page.path}>{page.path}</a>} · <span className={`page-state page-state-${page.state}`}>{STATE[page.state]}</span>
                  {page.hidden && " · Hidden from search engines"}
                </p>
                <p className="media-facts">
                  {page.draftAt
                    ? `Last changed ${formatInstant(new Date(page.draftAt))}${page.draftBy ? ` by ${page.draftBy}` : ""}.`
                    : page.publishedAt
                      ? `Published ${formatInstant(new Date(page.publishedAt))}${page.publishedBy ? ` by ${page.publishedBy}` : ""}.`
                      : ""}
                </p>
              </div>
              <span className="editor-row-buttons">
                <Link href={`/admin/website/pages/${page.id}`} className="btn btn-dark btn-small">
                  Edit {page.title}
                </Link>
                <form action={duplicatePageAction}>
                  <input type="hidden" name="id" value={page.id} />
                  <button type="submit" className="btn btn-outline btn-small" aria-label={`Copy ${page.title}`}>
                    Copy
                  </button>
                </form>
              </span>
            </li>
          ))}
        </ul>
      )}

      {trash.length > 0 && (
        <section className="admin-card" aria-labelledby="pages-trash">
          <h3 id="pages-trash">Trash</h3>
          <p className="editor-hint" style={{ margin: "0 0 1rem" }}>
            A deleted page is kept here for {TRASH_DAYS} days, then removed for good. Brought back, it is a draft.
          </p>
          <ul className="trash-list">
            {trash.map((page) => (
              <li key={page.id}>
                <span>
                  <strong>{page.title}</strong> · {page.path}
                  {page.deletedAt && ` · deleted ${formatInstant(new Date(page.deletedAt))}`}
                </span>
                <form action={restorePageAction}>
                  <input type="hidden" name="id" value={page.id} />
                  <button type="submit" className="btn btn-outline btn-small" aria-label={`Bring back ${page.title}`}>
                    Bring back
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="admin-card" aria-labelledby="pages-old-addresses">
        <h3 id="pages-old-addresses">Old addresses</h3>
        <p className="editor-hint" style={{ margin: "0 0 1rem" }}>
          An address that other sites and search engines still have, sent on to where its page is now. One is added by
          itself when a published page gets a new address.
        </p>
        {redirects.length > 0 && (
          <ul className="trash-list">
            {redirects.map((entry) => (
              <li key={entry.from}>
                <span>
                  {entry.from} → {entry.to}
                </span>
                {may.publish && (
                  <form action={removeRedirectAction}>
                    <input type="hidden" name="from" value={entry.from} />
                    <button type="submit" className="btn btn-outline btn-small" aria-label={`Stop sending ${entry.from} on`}>
                      Remove
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        {may.publish && (
          <form action={addRedirectAction} className="admin-form-row" style={{ marginTop: "1rem" }}>
            <div className="form-group">
              <label className="form-label" htmlFor="redirect-from">
                Old address
              </label>
              <input id="redirect-from" name="from" className="form-control" placeholder="/old-page" maxLength={200} required />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="redirect-to">
                Leads to
              </label>
              <input id="redirect-to" name="to" className="form-control" placeholder="/rates" maxLength={300} required />
            </div>
            <button type="submit" className="btn btn-dark btn-small">
              Send it on
            </button>
          </form>
        )}
      </section>
    </AdminFrame>
  );
}
