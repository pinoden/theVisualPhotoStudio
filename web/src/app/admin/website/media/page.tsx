import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { MediaUploader } from "@/components/media/MediaUploader";
import { ReplacePicture } from "@/components/media/ReplacePicture";
import { getDb } from "@/db/client";
import { count } from "@/lib/words";
import { listMedia, MEDIA_LIMITS, usesInWords, type MediaFilter } from "@/server/media";
import { requireManager } from "@/server/session";
import { loadSettings } from "@/server/settings";
import { AdminFrame, AdminLoading } from "../../frame";
import { WebsiteTabs } from "../tabs";
import { deleteMediaAction, describeMediaAction } from "./actions";

export const metadata: Metadata = { title: "Pictures", robots: { index: false } };

export default function MediaPage(props: PageProps<"/admin/website/media">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Library searchParams={props.searchParams} />
    </Suspense>
  );
}

const FILTERS: { value: MediaFilter; label: string }[] = [
  { value: "all", label: "Every picture" },
  { value: "undescribed", label: "Without a description" },
  { value: "unused", label: "Not shown anywhere" },
];

/** 1536000 -> "1.5 MB" */
function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * The media library: every picture the website can show. For an owner, or a
 * manager who may change the website. Anyone else gets "not found".
 */
async function Library({ searchParams }: Pick<PageProps<"/admin/website/media">, "searchParams">) {
  await connection();
  const viewer = await requireManager("/admin/website/media");
  const query = await searchParams;
  const q = typeof query.q === "string" ? query.q.slice(0, 100) : "";
  const filter: MediaFilter = query.show === "undescribed" || query.show === "unused" ? query.show : "all";
  const db = await getDb();
  const [items, settings] = await Promise.all([listMedia(db, viewer, { q, filter }), loadSettings(db)]);
  if (!items) notFound();
  const here = `/admin/website/media${q || filter !== "all" ? `?${new URLSearchParams({ ...(q ? { q } : {}), ...(filter !== "all" ? { show: filter } : {}) })}` : ""}`;

  return (
    <AdminFrame active="/admin/website" title="Pictures" query={query} viewer={viewer} settings={settings}>
      <WebsiteTabs active="/admin/website/media" viewer={viewer} />

      <div className="admin-card">
        <h3>Add pictures</h3>
        <MediaUploader />
      </div>

      <form method="get" className="admin-card admin-form-row" role="search">
        <div className="form-group" style={{ flex: "2 1 14rem" }}>
          <label className="form-label" htmlFor="media-q">
            Search by name or description
          </label>
          <input id="media-q" name="q" type="search" className="form-control" defaultValue={q} maxLength={100} />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="media-show">
            Show
          </label>
          <select id="media-show" name="show" className="form-control" defaultValue={filter}>
            {FILTERS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn btn-outline btn-small">
          Show
        </button>
      </form>

      {items.length === 0 ? (
        <div className="admin-card">
          <p style={{ margin: 0 }}>
            {q || filter !== "all" ? (
              <>
                No picture matches. <Link href="/admin/website/media">Show every picture</Link>
              </>
            ) : (
              "No pictures yet. Add the first with the button above."
            )}
          </p>
        </div>
      ) : (
        <>
          <p className="editor-hint" style={{ margin: "0 0 1rem" }}>
            {count(items.length, "picture")}. A picture is described once, here, and the description goes wherever the
            picture is shown.
          </p>
          <div className="media-grid">
            {items.map((item, index) => (
              <article className="media-card admin-card" key={item.id} aria-label={item.alt || item.filename}>
                <a href={item.url} target="_blank" rel="noopener" className="media-thumb" title="Open the picture">
                  <Image
                    src={item.url}
                    width={item.width}
                    height={item.height}
                    alt={item.alt || item.filename}
                    sizes="(max-width: 600px) 90vw, 280px"
                    // The first row is on screen when the page opens; the rest load as they are scrolled to.
                    loading={index < 4 ? "eager" : "lazy"}
                  />
                </a>
                <p className="media-facts">
                  {item.filename} · {item.width} × {item.height} · {size(item.size)}
                </p>
                <p className="media-facts">{item.uses.length > 0 ? `Shown in ${usesInWords(item.uses)}.` : "Not shown anywhere yet."}</p>
                {item.alt === "" && <p className="media-needs">Needs a description before it can be shown.</p>}
                <form action={describeMediaAction}>
                  <input type="hidden" name="id" value={item.id} />
                  <input type="hidden" name="back" value={here} />
                  <div className="form-group">
                    <label className="form-label" htmlFor={`alt-${item.id}`}>
                      What the picture shows
                    </label>
                    <input id={`alt-${item.id}`} name="alt" className="form-control" maxLength={MEDIA_LIMITS.alt} defaultValue={item.alt} />
                    <div className="editor-hint">For someone who cannot see it, and for search engines.</div>
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor={`caption-${item.id}`}>
                      Words under it in a gallery
                    </label>
                    <input id={`caption-${item.id}`} name="caption" className="form-control" maxLength={MEDIA_LIMITS.caption} defaultValue={item.caption} />
                  </div>
                  <button type="submit" className="btn btn-dark btn-small">
                    Save
                  </button>
                </form>
                <ReplacePicture id={item.id} name={item.alt || item.filename} />
                <details className="media-delete">
                  <summary>Delete this picture</summary>
                  {item.uses.length > 0 ? (
                    <p className="editor-hint">It is shown in {usesInWords(item.uses)}. Take it out there first.</p>
                  ) : (
                    <form action={deleteMediaAction}>
                      <input type="hidden" name="id" value={item.id} />
                      <input type="hidden" name="back" value={here} />
                      <p className="editor-hint">It is not shown anywhere. Deleting cannot be undone.</p>
                      <button type="submit" className="btn btn-outline btn-small">
                        Yes, delete it
                      </button>
                    </form>
                  )}
                </details>
              </article>
            ))}
          </div>
        </>
      )}
    </AdminFrame>
  );
}
