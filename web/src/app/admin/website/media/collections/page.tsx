import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { count } from "@/lib/words";
import { COLLECTION_LIMITS, listCollections, showsInWords } from "@/server/collections";
import { requireManager } from "@/server/session";
import { loadSettings } from "@/server/settings";
import { localDateOf } from "@/server/tz";
import { AdminFrame, AdminLoading } from "../../../frame";
import { WebsiteTabs } from "../../tabs";
import { createCollectionAction } from "../actions";

export const metadata: Metadata = { title: "Collections", robots: { index: false } };

export default function CollectionsPage(props: PageProps<"/admin/website/media/collections">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Collections searchParams={props.searchParams} />
    </Suspense>
  );
}

/** The collections of the media library. For an owner, or a manager who may change the website. */
async function Collections({ searchParams }: Pick<PageProps<"/admin/website/media/collections">, "searchParams">) {
  await connection();
  const viewer = await requireManager("/admin/website/media/collections");
  const db = await getDb();
  const [collections, settings] = await Promise.all([listCollections(db, viewer), loadSettings(db)]);
  if (!collections) notFound();
  const today = localDateOf(new Date());

  return (
    <AdminFrame active="/admin/website" title="Collections" query={await searchParams} viewer={viewer} settings={settings}>
      <WebsiteTabs active="/admin/website/media/collections" />
      <div className="admin-card">
        <p style={{ margin: 0, fontSize: ".9rem" }}>
          A collection is a set of pictures from the library, in the order you put them: a season&rsquo;s sets, a
          studio&rsquo;s decor, one gallery. With a first and a last day it shows only between them, so a seasonal
          gallery appears and goes by itself.
        </p>
      </div>

      <form action={createCollectionAction} className="admin-card admin-form-row">
        <div className="form-group" style={{ flex: "2 1 14rem" }}>
          <label className="form-label" htmlFor="collection-name">
            Name of a new collection
          </label>
          <input id="collection-name" name="name" className="form-control" maxLength={COLLECTION_LIMITS.name} required />
        </div>
        <button type="submit" className="btn btn-dark btn-small">
          Make the collection
        </button>
      </form>

      {collections.length === 0 ? (
        <div className="admin-card">
          <p style={{ margin: 0 }}>No collections yet.</p>
        </div>
      ) : (
        <div className="media-grid">
          {collections.map((collection) => (
            <article className="media-card admin-card" key={collection.id}>
              <Link href={`/admin/website/media/collections/${collection.id}`} className="media-thumb">
                {collection.cover ? (
                  <Image
                    src={collection.cover.url}
                    width={collection.cover.width}
                    height={collection.cover.height}
                    alt={collection.cover.alt || collection.name}
                    sizes="(max-width: 600px) 90vw, 280px"
                  />
                ) : (
                  <span className="media-empty">No pictures yet</span>
                )}
              </Link>
              <h3 style={{ margin: 0 }}>{collection.name}</h3>
              <p className="media-facts">
                {count(collection.count, "picture")}. {showsInWords(collection, today)}
              </p>
              <Link href={`/admin/website/media/collections/${collection.id}`} className="btn btn-outline btn-small">
                Open {collection.name}
              </Link>
            </article>
          ))}
        </div>
      )}
    </AdminFrame>
  );
}
