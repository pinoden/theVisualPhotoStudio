import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ChoosePictures } from "@/components/media/PictureChooser";
import { getDb } from "@/db/client";
import { COLLECTION_LIMITS, listCollections, loadCollection, showsInWords } from "@/server/collections";
import { requireManager } from "@/server/session";
import { loadSettings } from "@/server/settings";
import { localDateOf } from "@/server/tz";
import { AdminFrame, AdminLoading } from "../../../../frame";
import { WebsiteTabs } from "../../../tabs";
import {
  addToCollectionAction,
  deleteCollectionAction,
  moveEarlierInCollectionAction,
  moveLaterInCollectionAction,
  removeFromCollectionAction,
  saveCollectionAction,
} from "../../actions";

export const metadata: Metadata = { title: "Collection", robots: { index: false } };

export default function CollectionPage(props: PageProps<"/admin/website/media/collections/[id]">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <OneCollection params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

/** One collection: its name and dates, and its pictures in order. For an owner, or a manager who may change the website. */
async function OneCollection({ params, searchParams }: Pick<PageProps<"/admin/website/media/collections/[id]">, "params" | "searchParams">) {
  await connection();
  const { id } = await params;
  const here = `/admin/website/media/collections/${id}`;
  const viewer = await requireManager(here);
  const db = await getDb();
  // Asking for the list is how the viewer is checked: it is null for someone who may not see the library.
  const [allowed, collection, settings] = await Promise.all([listCollections(db, viewer), loadCollection(db, id), loadSettings(db)]);
  if (!allowed || !collection) notFound();
  const today = localDateOf(new Date());
  const last = collection.pictures.length - 1;

  return (
    <AdminFrame active="/admin/website" title={collection.name} query={await searchParams} viewer={viewer} settings={settings}>
      <WebsiteTabs active="/admin/website/media/collections" viewer={viewer} />
      <p style={{ margin: "-.75rem 0 1.25rem", fontSize: ".85rem" }}>
        <Link href="/admin/website/media/collections">← All collections</Link>
      </p>

      <form action={saveCollectionAction} className="admin-card">
        <input type="hidden" name="id" value={collection.id} />
        <input type="hidden" name="back" value={here} />
        <h3>Name and dates</h3>
        <div className="form-group">
          <label className="form-label" htmlFor="collection-name">
            Name
          </label>
          <input id="collection-name" name="name" className="form-control" maxLength={COLLECTION_LIMITS.name} defaultValue={collection.name} required />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="collection-description">
            A few words about it
          </label>
          <input id="collection-description" name="description" className="form-control" maxLength={COLLECTION_LIMITS.description} defaultValue={collection.description} />
        </div>
        <div className="admin-form-row">
          <div className="form-group">
            <label className="form-label" htmlFor="collection-starts">
              First day it shows
            </label>
            <input id="collection-starts" name="startsOn" type="date" className="form-control" defaultValue={collection.startsOn ?? ""} />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="collection-ends">
              Last day it shows
            </label>
            <input id="collection-ends" name="endsOn" type="date" className="form-control" defaultValue={collection.endsOn ?? ""} />
          </div>
        </div>
        <p className="editor-hint" style={{ margin: "0 0 1rem" }}>
          Leave both empty to show it all year. {showsInWords(collection, today)}
        </p>
        <button type="submit" className="btn btn-dark btn-small">
          Save
        </button>
      </form>

      <div className="admin-card">
        <h3>Pictures</h3>
        <p className="editor-hint" style={{ margin: "0 0 1rem" }}>
          They are shown in this order. A picture taken out of the collection stays in the library.
        </p>
        <ChoosePictures label="Add pictures from the library" action={addToCollectionAction} fields={{ id: collection.id, back: here }} />
        {collection.pictures.length === 0 ? (
          <p style={{ margin: "1rem 0 0" }}>No pictures in this collection yet.</p>
        ) : (
          <ol className="media-ordered">
            {collection.pictures.map((picture, index) => (
              <li key={picture.id}>
                <Image src={picture.url} width={picture.width} height={picture.height} alt={picture.alt} sizes="160px" />
                <span className="media-facts">{picture.alt || "No description yet"}</span>
                <span className="editor-row-buttons">
                  <form action={moveEarlierInCollectionAction}>
                    <input type="hidden" name="id" value={collection.id} />
                    <input type="hidden" name="mediaId" value={picture.id} />
                    <input type="hidden" name="back" value={here} />
                    <button type="submit" className="btn btn-outline btn-small" disabled={index === 0} aria-label={`Move picture ${index + 1} earlier`}>
                      ↑
                    </button>
                  </form>
                  <form action={moveLaterInCollectionAction}>
                    <input type="hidden" name="id" value={collection.id} />
                    <input type="hidden" name="mediaId" value={picture.id} />
                    <input type="hidden" name="back" value={here} />
                    <button type="submit" className="btn btn-outline btn-small" disabled={index === last} aria-label={`Move picture ${index + 1} later`}>
                      ↓
                    </button>
                  </form>
                  <form action={removeFromCollectionAction}>
                    <input type="hidden" name="id" value={collection.id} />
                    <input type="hidden" name="mediaId" value={picture.id} />
                    <input type="hidden" name="back" value={here} />
                    <button type="submit" className="btn btn-outline btn-small" aria-label={`Take picture ${index + 1} out of the collection`}>
                      Take out
                    </button>
                  </form>
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <details className="admin-card media-delete">
        <summary>Delete this collection</summary>
        <form action={deleteCollectionAction}>
          <input type="hidden" name="id" value={collection.id} />
          <input type="hidden" name="back" value={here} />
          <p className="editor-hint">Its pictures stay in the library. Deleting cannot be undone.</p>
          <button type="submit" className="btn btn-outline btn-small">
            Yes, delete the collection
          </button>
        </form>
      </details>
    </AdminFrame>
  );
}
