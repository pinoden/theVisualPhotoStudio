import type { Metadata } from "next";
import Image from "next/image";
import { connection } from "next/server";
import { Suspense } from "react";
import { ChoosePictures } from "@/components/media/PictureChooser";
import { getDb } from "@/db/client";
import { ADDON_KINDS } from "@/lib/addon-kinds";
import { centsToInput, MONEY_FIELD } from "@/lib/parse";
import { listAddons, type AdminAddon } from "@/server/admin";
import { loadCatalog, type CatalogStudio } from "@/server/catalog";
import { requireOwner } from "@/server/session";
import { STUDIO_PHOTO_LIMIT } from "@/server/studio-photos";
import {
  addStudioPhotosAction,
  moveStudioPhotoEarlierAction,
  moveStudioPhotoLaterAction,
  offerAddonAgainAction,
  removeStudioPhotoAction,
  saveAddonAction,
  saveStudioDetailsAction,
  stopOfferingAddonAction,
} from "../actions";
import { AdminFrame, AdminLoading } from "../frame";

export const metadata: Metadata = { title: "Studios & Add-ons", robots: { index: false } };

export default function StudiosAdminPage(props: PageProps<"/admin/studios">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <StudiosAndAddons searchParams={props.searchParams} />
    </Suspense>
  );
}

const HELP = { fontSize: ".78rem", marginTop: ".25rem" } as const;

/** The fields of one add-on. `id` keeps the field ids on the page apart: the add-on's slug, or "new". */
function AddonFields({ id, addon, studios }: { id: string; addon?: AdminAddon; studios: CatalogStudio[] }) {
  return (
    <>
      <div className="admin-form-row">
        <div className="form-group" style={{ flex: "2 1 14rem" }}>
          <label className="form-label" htmlFor={`addon-${id}-name`}>
            Name
          </label>
          <input
            id={`addon-${id}-name`}
            name="name"
            className="form-control"
            maxLength={80}
            defaultValue={addon?.name ?? ""}
            required
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor={`addon-${id}-price`}>
            Price ($)
          </label>
          <input
            id={`addon-${id}-price`}
            name="price"
            className="form-control price-input"
            {...MONEY_FIELD}
            defaultValue={addon ? centsToInput(addon.priceCents) : ""}
            required
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor={`addon-${id}-kind`}>
            What it is for
          </label>
          <select id={`addon-${id}-kind`} name="kind" className="form-control" defaultValue={addon?.kind ?? "other"}>
            {Object.entries(ADDON_KINDS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor={`addon-${id}-studio`}>
            Offered with
          </label>
          <select id={`addon-${id}-studio`} name="studioId" className="form-control" defaultValue={addon?.studioId ?? ""}>
            <option value="">Any booking</option>
            {studios.map((studio) => (
              <option key={studio.id} value={studio.id}>
                {studio.name} only
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor={`addon-${id}-description`}>
          Description
        </label>
        <input
          id={`addon-${id}-description`}
          name="description"
          className="form-control"
          maxLength={300}
          defaultValue={addon?.description ?? ""}
        />
      </div>
    </>
  );
}

/** A studio's photos: pictures of the media library in the owners' order, with the buttons to reorder and remove them. */
function StudioPhotos({ studio }: { studio: CatalogStudio }) {
  const last = studio.photos.length - 1;
  return (
    <div className="studio-photos">
      <h4 className="editor-subtitle">Photos of {studio.name}</h4>
      <p style={HELP}>
        From the media library. The first is the one on the studio&rsquo;s card; all of them are on the studios page.
        A change shows to customers at once. Up to {STUDIO_PHOTO_LIMIT}.
      </p>
      {studio.photos.length > 0 && (
        <ol className="media-ordered">
          {studio.photos.map((photo, index) => (
            <li key={photo.id}>
              <Image src={photo.url} width={photo.width} height={photo.height} alt={photo.alt} sizes="160px" />
              <span className="media-facts">{photo.alt}</span>
              <span className="editor-row-buttons">
                <form action={moveStudioPhotoEarlierAction}>
                  <input type="hidden" name="studioId" value={studio.id} />
                  <input type="hidden" name="mediaId" value={photo.id} />
                  <button type="submit" className="btn btn-outline btn-small" disabled={index === 0} aria-label={`Move photo ${index + 1} of ${studio.name} earlier`}>
                    ↑
                  </button>
                </form>
                <form action={moveStudioPhotoLaterAction}>
                  <input type="hidden" name="studioId" value={studio.id} />
                  <input type="hidden" name="mediaId" value={photo.id} />
                  <button type="submit" className="btn btn-outline btn-small" disabled={index === last} aria-label={`Move photo ${index + 1} of ${studio.name} later`}>
                    ↓
                  </button>
                </form>
                <form action={removeStudioPhotoAction}>
                  <input type="hidden" name="studioId" value={studio.id} />
                  <input type="hidden" name="mediaId" value={photo.id} />
                  <button type="submit" className="btn btn-outline btn-small" aria-label={`Take photo ${index + 1} off ${studio.name}`}>
                    Take off
                  </button>
                </form>
              </span>
            </li>
          ))}
        </ol>
      )}
      {studio.photos.length < STUDIO_PHOTO_LIMIT && (
        <ChoosePictures label={`Add photos of ${studio.name}`} action={addStudioPhotosAction} fields={{ studioId: studio.id }} />
      )}
    </div>
  );
}

async function StudiosAndAddons({ searchParams }: Pick<PageProps<"/admin/studios">, "searchParams">) {
  await connection();
  await requireOwner("/admin/studios");
  const db = await getDb();
  const [catalog, addons] = await Promise.all([loadCatalog(db), listAddons(db)]);

  return (
    <AdminFrame active="/admin/studios" title="Studios & add-ons" query={await searchParams}>
      {catalog.studios.map((studio) => (
        <div className="admin-card" key={studio.id}>
          <form action={saveStudioDetailsAction}>
            <h3>{studio.name}</h3>
            <input type="hidden" name="studioId" value={studio.id} />
            <div className="form-group">
              <label className="form-label" htmlFor={`studio-${studio.slug}-tagline`}>
                Tagline
              </label>
              <input
                id={`studio-${studio.slug}-tagline`}
                name="tagline"
                className="form-control"
                maxLength={200}
                defaultValue={studio.tagline}
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor={`studio-${studio.slug}-description`}>
                Description
              </label>
              <textarea
                id={`studio-${studio.slug}-description`}
                name="description"
                className="form-control"
                rows={3}
                maxLength={2000}
                defaultValue={studio.description}
              />
            </div>
            <div className="admin-form-row">
              <div className="form-group">
                <label className="form-label" htmlFor={`studio-${studio.slug}-guests`}>
                  Guests included in the price
                </label>
                <input
                  id={`studio-${studio.slug}-guests`}
                  name="includedGuests"
                  className="form-control price-input"
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  defaultValue={studio.includedGuests}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor={`studio-${studio.slug}-buffer`}>
                  Kept free after a booking (minutes)
                </label>
                <input
                  id={`studio-${studio.slug}-buffer`}
                  name="bufferMinutes"
                  className="form-control price-input"
                  type="number"
                  min={0}
                  max={240}
                  step={1}
                  defaultValue={studio.bufferMinutes}
                  required
                />
              </div>
              <button type="submit" className="btn btn-dark btn-small">
                Save {studio.name}
              </button>
            </div>
            <div style={HELP}>
              The guest number is shown to customers and is not enforced. The time kept free after a booking is the
              least gap between two appointments: 15 is 7 minutes before and 7 after each, as the calendar draws them. A
              new value applies to bookings made from now on.
            </div>
          </form>
          <StudioPhotos studio={studio} />
        </div>
      ))}

      <div className="admin-card">
        <h3>Add-ons</h3>
        <p style={{ fontSize: ".875rem" }}>
          Extras a customer can add while booking, once per booking. A change applies to new bookings; bookings
          already made keep the name and price they were made with. The Guest Information page uses &ldquo;What it is
          for&rdquo; to answer whether larger groups and pets can be booked.
        </p>
        {addons.map((addon) => (
          <form
            action={saveAddonAction}
            key={addon.id}
            style={{ borderTop: "1px solid var(--color-border)", paddingTop: "1rem", marginTop: "1rem" }}
          >
            <input type="hidden" name="addonId" value={addon.id} />
            {!addon.active && (
              <p className="field-error" style={{ margin: "0 0 .75rem" }}>
                Not offered at the moment.
              </p>
            )}
            <AddonFields id={addon.slug} addon={addon} studios={catalog.studios} />
            <div style={{ display: "flex", gap: ".75rem", flexWrap: "wrap" }}>
              <button type="submit" className="btn btn-dark btn-small">
                Save {addon.name}
              </button>
              <button
                type="submit"
                formAction={addon.active ? stopOfferingAddonAction : offerAddonAgainAction}
                className="btn btn-outline btn-small"
              >
                {addon.active ? `Stop offering ${addon.name}` : `Offer ${addon.name} again`}
              </button>
            </div>
          </form>
        ))}

        <form
          action={saveAddonAction}
          style={{ borderTop: "1px solid var(--color-border)", paddingTop: "1rem", marginTop: "1rem" }}
        >
          <h3>Add an add-on</h3>
          <AddonFields id="new" studios={catalog.studios} />
          <button type="submit" className="btn btn-dark btn-small">
            Add add-on
          </button>
        </form>
      </div>
    </AdminFrame>
  );
}
