"use client";

/**
 * The calendar's zoom, as a dropdown (the owner, 2026-11-23: "0.25; 0.5; 0.75; normal; 1.25; 1.5; 2 ... more pretty as a
 * dropdown"). A plain form that reloads the calendar at the size chosen, sent as soon as one is picked; without its
 * script, by the button beside it. It keeps the view, the day, the studio and the appointment open.
 */
export function ZoomSelect({ sizes, current, keep }: { sizes: { value: string; label: string }[]; current: string; keep: Record<string, string> }) {
  return (
    <form method="get" action="/admin/calendar" className="cal-zoom">
      {Object.entries(keep).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <label htmlFor="cal-zoom-size" className="cal-zoom-label">
        Zoom
      </label>
      <select id="cal-zoom-size" name="zoom" className="form-control" defaultValue={current} onChange={(event) => event.currentTarget.form?.requestSubmit()}>
        {sizes.map((size) => (
          <option key={size.value} value={size.value}>
            {size.label}
          </option>
        ))}
      </select>
      <noscript>
        <button type="submit" className="btn btn-outline btn-small">
          Show
        </button>
      </noscript>
    </form>
  );
}
