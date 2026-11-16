import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { can } from "@/lib/abilities";
import { minutesToHHMM, weekdayName } from "@/lib/domain/time";
import { listBlocks } from "@/server/admin";
import { loadCatalog } from "@/server/catalog";
import { requireManager } from "@/server/session";
import { formatRange, localDateOf } from "@/server/tz";
import { createBlockAction, removeBlockAction, saveHoursAction } from "../actions";
import { AdminFrame, AdminLoading } from "../frame";

export const metadata: Metadata = { title: "Hours & Blocks", robots: { index: false } };

export default function HoursPage(props: PageProps<"/admin/hours">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Hours searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Hours({ searchParams }: Pick<PageProps<"/admin/hours">, "searchParams">) {
  await connection();
  // Blocking time can be a manager's job. Opening hours decide what customers can book, and stay with the owners.
  const viewer = await requireManager("/admin/hours");
  const db = await getDb();
  const now = new Date();
  const [catalog, blocks] = await Promise.all([loadCatalog(db), listBlocks(db, now)]);
  if (!can(viewer, "blockTime", catalog.settings)) notFound();
  const today = localDateOf(now);
  const owner = viewer.role === "owner";

  return (
    <AdminFrame active="/admin/hours" title={owner ? "Hours & blocks" : "Blocked time"} query={await searchParams} viewer={viewer} settings={catalog.settings}>
      <div className="admin-card">
        <h3>Block time</h3>
        <p style={{ fontSize: ".875rem" }}>
          Take studios off the calendar for maintenance or a private event. Time that already has a booking cannot be
          blocked; cancel the booking first.
        </p>
        <form action={createBlockAction}>
          <div className="admin-form-row">
            <div className="form-group">
              <span className="form-label">Studios</span>
              {catalog.studios.map((studio) => (
                <label key={studio.id} style={{ marginRight: "1rem", fontSize: ".875rem" }}>
                  <input type="checkbox" name="studio" value={studio.id} /> {studio.name}
                </label>
              ))}
            </div>
          </div>
          <div className="admin-form-row">
            <div className="form-group">
              <label className="form-label" htmlFor="block-date">
                Date
              </label>
              <input id="block-date" name="date" type="date" className="form-control" min={today} required />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="block-start">
                From
              </label>
              <input id="block-start" name="start" type="time" className="form-control" defaultValue="09:00" required />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="block-end">
                To
              </label>
              <input id="block-end" name="end" type="time" className="form-control" defaultValue="19:00" required />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="block-note">
                Note
              </label>
              <input id="block-note" name="note" className="form-control" maxLength={200} />
            </div>
            <button type="submit" className="btn btn-dark btn-small">
              Block
            </button>
          </div>
        </form>

        {blocks.length > 0 && (
          <table className="data-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Studios</th>
                <th>Note</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {blocks.map((block) => {
                const when = formatRange(new Date(block.startAt), new Date(block.endAt));
                return (
                  <tr key={block.id}>
                    <td>
                      {when.day}, {when.time}
                    </td>
                    <td>{block.studios.join(", ")}</td>
                    <td>{block.note}</td>
                    <td>
                      <form action={removeBlockAction}>
                        <input type="hidden" name="blockId" value={block.id} />
                        <button type="submit" className="btn btn-outline btn-small">
                          Remove
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {(owner ? catalog.studios : []).map((studio) => (
        <div className="admin-card" key={studio.id}>
          <h3>{studio.name}: opening hours</h3>
          <form action={saveHoursAction}>
            <input type="hidden" name="studioId" value={studio.id} />
            <table className="data-table" style={{ maxWidth: 560 }}>
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Opens</th>
                  <th>Closes</th>
                  <th>Closed</th>
                </tr>
              </thead>
              <tbody>
                {[1, 2, 3, 4, 5, 6, 7].map((weekday) => {
                  const hours = studio.hours[weekday];
                  return (
                    <tr key={weekday}>
                      <td>{weekdayName(weekday)}</td>
                      <td>
                        <input
                          type="time"
                          name={`open:${weekday}`}
                          className="price-input"
                          aria-label={`${studio.name} ${weekdayName(weekday)} opens`}
                          defaultValue={minutesToHHMM(hours?.openMinute ?? 540)}
                        />
                      </td>
                      <td>
                        <input
                          type="time"
                          name={`close:${weekday}`}
                          className="price-input"
                          aria-label={`${studio.name} ${weekdayName(weekday)} closes`}
                          defaultValue={minutesToHHMM(hours?.closeMinute ?? 1140)}
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          name={`closed:${weekday}`}
                          aria-label={`${studio.name} closed on ${weekdayName(weekday)}`}
                          defaultChecked={!hours}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <button type="submit" className="btn btn-dark btn-small" style={{ marginTop: "1rem" }}>
              Save {studio.name} hours
            </button>
          </form>
        </div>
      ))}
    </AdminFrame>
  );
}
