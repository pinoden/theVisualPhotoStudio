import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { centsToInput } from "@/lib/parse";
import { listAddons, type AdminAddon } from "@/server/admin";
import { loadCatalog, type CatalogStudio } from "@/server/catalog";
import { requireOwner } from "@/server/session";
import {
  offerAddonAgainAction,
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
            inputMode="decimal"
            defaultValue={addon ? centsToInput(addon.priceCents) : ""}
            required
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor={`addon-${id}-max`}>
            Most per booking
          </label>
          <input
            id={`addon-${id}-max`}
            name="maxQuantity"
            className="form-control price-input"
            inputMode="numeric"
            defaultValue={addon?.maxQuantity ?? 1}
            required
          />
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

async function StudiosAndAddons({ searchParams }: Pick<PageProps<"/admin/studios">, "searchParams">) {
  await connection();
  await requireOwner("/admin/studios");
  const db = await getDb();
  const [catalog, addons] = await Promise.all([loadCatalog(db), listAddons(db)]);

  return (
    <AdminFrame active="/admin/studios" title="Studios & add-ons" query={await searchParams}>
      {catalog.studios.map((studio) => (
        <form action={saveStudioDetailsAction} className="admin-card" key={studio.id}>
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
                inputMode="numeric"
                defaultValue={studio.includedGuests}
                required
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor={`studio-${studio.slug}-buffer`}>
                Clean-up after a booking (minutes)
              </label>
              <input
                id={`studio-${studio.slug}-buffer`}
                name="bufferMinutes"
                className="form-control price-input"
                inputMode="numeric"
                defaultValue={studio.bufferMinutes}
                required
              />
            </div>
            <button type="submit" className="btn btn-dark btn-small">
              Save {studio.name}
            </button>
          </div>
          <div style={HELP}>
            The guest number is shown to customers and is not enforced. A new clean-up time applies to bookings made
            from now on.
          </div>
        </form>
      ))}

      <div className="admin-card">
        <h3>Add-ons</h3>
        <p style={{ fontSize: ".875rem" }}>
          Extras a customer can add while booking. A change applies to new bookings; bookings already made keep the
          name and price they were made with.
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
