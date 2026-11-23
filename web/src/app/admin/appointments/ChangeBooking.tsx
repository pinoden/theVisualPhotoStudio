import { formatCents } from "@/lib/domain/pricing";
import { durationLabel } from "@/lib/domain/time";
import { OverrideSubmit } from "@/components/OverrideSubmit";
import type { EditOptions } from "@/server/edit-booking";
import { changeConflictsAction, editBookingAction } from "./actions";

/**
 * An owner's form to change a booking's studios, length, guests and add-ons (the owner's admin brief of 2026-11-22,
 * item 5; "Editing price is for owner only", 2026-11-23; question 75 in ProjectLibrary.md). It keeps its day and start;
 * the price is worked out again, and the client is emailed.
 */
export function ChangeBooking({ bookingRef, options }: { bookingRef: string; options: Extract<EditOptions, { editable: true }> }) {
  return (
    <form action={editBookingAction} className="change-booking" aria-label="Change the booking">
      <input type="hidden" name="ref" value={bookingRef} />
      <fieldset className="form-group">
        <legend className="form-label">Studios</legend>
        {options.studios.map((studio) => (
          <label key={studio.id} className="admin-check" style={{ display: "inline-flex", marginRight: "1rem" }}>
            <input type="checkbox" name="studio" value={studio.id} defaultChecked={studio.chosen} /> {studio.name}
          </label>
        ))}
      </fieldset>
      <div className="form-group">
        <label className="form-label" htmlFor="change-length">
          Length
        </label>
        <select id="change-length" name="duration" className="form-control" defaultValue={String(options.durationMinutes)} style={{ maxWidth: "12rem" }}>
          {options.lengths.map((minutes) => (
            <option key={minutes} value={minutes}>
              {durationLabel(minutes)}
            </option>
          ))}
        </select>
      </div>
      {options.addons.length > 0 && (
        <fieldset className="form-group">
          <legend className="form-label">Add-ons and extra guests</legend>
          <div className="admin-form-row" style={{ marginBottom: 0 }}>
            {options.addons.map((addon) => (
              <div className="form-group" key={addon.id}>
                <label className="form-label" htmlFor={`change-addon-${addon.id}`}>
                  {addon.name} ({formatCents(addon.priceCents)} each{addon.studioName ? `, ${addon.studioName} only` : ""})
                </label>
                <input
                  id={`change-addon-${addon.id}`}
                  name={`addon:${addon.id}`}
                  type="number"
                  min={0}
                  max={addon.most}
                  step={1}
                  className="form-control price-input"
                  defaultValue={addon.quantity}
                />
              </div>
            ))}
          </div>
        </fieldset>
      )}
      <p style={{ fontSize: ".85rem" }}>
        The booking keeps its day and start. Its price is worked out again at today&rsquo;s prices, the add-ons it keeps at
        theirs, and the client is emailed the change. What it then owes, or was paid beyond its new price, shows under
        Payment below. Should the change pass over the opening hours, another booking or blocked time, a pop-up says so first,
        and only OK saves it.
      </p>
      <OverrideSubmit check={changeConflictsAction} className="btn btn-dark btn-small">
        Save the change
      </OverrideSubmit>
    </form>
  );
}
