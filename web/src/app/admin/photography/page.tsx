import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { durationLabel, minutesToHHMM, weekdayName } from "@/lib/domain/time";
import { centsToInput, PRICE_FIELD } from "@/lib/parse";
import { can } from "@/lib/abilities";
import { listPhotoPackages, listPhotographerBlocks, loadPhotographer } from "@/server/photography";
import { requireStaff } from "@/server/session";
import { loadSettings } from "@/server/settings";
import { formatRange, localDateOf } from "@/server/tz";
import { AdminFrame, AdminLoading } from "../frame";
import {
  blockPhotographerAction,
  savePhotoPackageAction,
  savePhotographerHoursAction,
  unblockPhotographerAction,
} from "./actions";

export const metadata: Metadata = { title: "Photography", robots: { index: false } };

export default function PhotographyAdminPage(props: PageProps<"/admin/photography">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Photography searchParams={props.searchParams} />
    </Suspense>
  );
}

/**
 * The photographer's availability, and the sessions on sale. The owners see
 * all of it. Staff see the hours and the blocked time when the owners have
 * switched that on for them, and never the packages and prices.
 */
async function Photography({ searchParams }: Pick<PageProps<"/admin/photography">, "searchParams">) {
  await connection();
  const viewer = await requireStaff("/admin/photography");
  const db = await getDb();
  const settings = await loadSettings(db);
  if (!can(viewer, "setPhotographerTimes", settings)) notFound();

  const now = new Date();
  const [photographer, blocks, packages] = await Promise.all([
    loadPhotographer(db),
    listPhotographerBlocks(db, now),
    viewer.role === "owner" ? listPhotoPackages(db) : [],
  ]);
  const studios = [...new Set(packages.map((pack) => pack.studioName))];

  return (
    <AdminFrame active="/admin/photography" title="Photography" query={await searchParams} viewer={viewer} settings={settings}>
      <div className="admin-card">
        <h3>How it works</h3>
        <p style={{ fontSize: ".875rem", margin: 0 }}>
          A photography session needs a studio and the photographer. Customers are offered only the times at which
          both are free: inside the photographer&rsquo;s working hours, outside the time blocked below, and never while
          the photographer is at another session, whatever the studio. A session holds the photographer for its length
          and the 15 minutes after it.
        </p>
      </div>

      {!photographer ? (
        <div className="admin-card">There is no photographer to book, so no sessions are on sale.</div>
      ) : (
        <>
          <div className="admin-card">
            <h3>Working hours</h3>
            <p style={{ fontSize: ".875rem" }}>The hours {photographer.name === "In-house photographer" ? "the photographer is" : `${photographer.name} is`} ready to work, by day of the week.</p>
            <form action={savePhotographerHoursAction}>
              <div className="data-table-wrap">
                <table className="data-table" style={{ maxWidth: 560 }}>
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th>From</th>
                      <th>To</th>
                      <th>Not working</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[1, 2, 3, 4, 5, 6, 7].map((weekday) => {
                      const hours = photographer.hours[weekday];
                      return (
                        <tr key={weekday}>
                          <td>{weekdayName(weekday)}</td>
                          <td>
                            <input
                              type="time"
                              name={`from:${weekday}`}
                              className="price-input"
                              aria-label={`${weekdayName(weekday)} from`}
                              defaultValue={minutesToHHMM(hours?.openMinute ?? 540)}
                            />
                          </td>
                          <td>
                            <input
                              type="time"
                              name={`to:${weekday}`}
                              className="price-input"
                              aria-label={`${weekdayName(weekday)} to`}
                              defaultValue={minutesToHHMM(hours?.closeMinute ?? 1140)}
                            />
                          </td>
                          <td>
                            <input
                              type="checkbox"
                              name={`off:${weekday}`}
                              aria-label={`Not working on ${weekdayName(weekday)}`}
                              defaultChecked={!hours}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <button type="submit" className="btn btn-dark btn-small" style={{ marginTop: "1rem" }}>
                Save working hours
              </button>
            </form>
          </div>

          <div className="admin-card">
            <h3>Blocked time</h3>
            <p style={{ fontSize: ".875rem" }}>
              Time inside the working hours when the photographer cannot take a session: a day off, a job elsewhere.
            </p>
            <form action={blockPhotographerAction} className="admin-form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="photo-block-date">
                  Date
                </label>
                <input id="photo-block-date" name="date" type="date" className="form-control" min={localDateOf(now)} required />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="photo-block-start">
                  From
                </label>
                <input id="photo-block-start" name="start" type="time" className="form-control" defaultValue="09:00" required />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="photo-block-end">
                  To
                </label>
                <input id="photo-block-end" name="end" type="time" className="form-control" defaultValue="19:00" required />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="photo-block-note">
                  Note
                </label>
                <input id="photo-block-note" name="note" className="form-control" maxLength={200} />
              </div>
              <button type="submit" className="btn btn-dark btn-small">
                Block
              </button>
            </form>
            {blocks.length === 0 ? (
              <p style={{ fontSize: ".875rem", margin: 0 }}>Nothing is blocked.</p>
            ) : (
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>When</th>
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
                          <td>{block.note}</td>
                          <td>
                            <form action={unblockPhotographerAction}>
                              <input type="hidden" name="holdId" value={block.id} />
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
              </div>
            )}
          </div>
        </>
      )}

      {viewer.role === "owner" && (
        <div className="admin-card">
          <h3>Sessions on sale</h3>
          <p style={{ fontSize: ".875rem" }}>
            The price of a session includes the studio. A change applies to new bookings; sessions already booked keep
            what they were sold with.
          </p>
          {studios.map((studio) => (
            <div key={studio} style={{ borderTop: "1px solid var(--color-border)", paddingTop: "1rem", marginTop: "1rem" }}>
              <h4 style={{ margin: "0 0 .75rem" }}>{studio}</h4>
              {packages
                .filter((pack) => pack.studioName === studio)
                .map((pack) => {
                  const id = `${pack.studioName}-${pack.durationMinutes}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
                  return (
                    <form action={savePhotoPackageAction} className="admin-form-row" key={pack.id}>
                      <input type="hidden" name="packageId" value={pack.id} />
                      <div className="form-group">
                        <span className="form-label">Length</span>
                        <div style={{ padding: ".5rem 0", minWidth: "5rem" }}>{durationLabel(pack.durationMinutes)}</div>
                      </div>
                      <div className="form-group">
                        <label className="form-label" htmlFor={`pack-${id}-price`}>
                          Price ($)
                        </label>
                        <input
                          id={`pack-${id}-price`}
                          name="price"
                          className="form-control price-input"
                          {...PRICE_FIELD}
                          defaultValue={centsToInput(pack.priceCents)}
                          required
                        />
                      </div>
                      <div className="form-group" style={{ flex: "2 1 14rem" }}>
                        <label className="form-label" htmlFor={`pack-${id}-includes`}>
                          Includes
                        </label>
                        <input id={`pack-${id}-includes`} name="includes" className="form-control" maxLength={200} defaultValue={pack.includes} />
                      </div>
                      <label className="admin-check">
                        <input type="checkbox" name="onSale" defaultChecked={pack.active} /> On sale
                      </label>
                      <button type="submit" className="btn btn-dark btn-small">
                        Save
                      </button>
                    </form>
                  );
                })}
            </div>
          ))}
        </div>
      )}
    </AdminFrame>
  );
}
