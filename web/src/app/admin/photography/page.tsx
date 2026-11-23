import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ChoosePictures } from "@/components/media/PictureChooser";
import { getDb } from "@/db/client";
import { durationLabel, minutesToHHMM, weekdayName } from "@/lib/domain/time";
import { centsToInput, PRICE_FIELD } from "@/lib/parse";
import { can } from "@/lib/abilities";
import { daysText, listPhotoPackages, listPhotographerBlocks, loadPhotographer } from "@/server/photography";
import { loadPhotographyPhotos, pagesShowingPhotographyPhotos, PHOTOGRAPHY_PHOTO_LIMIT } from "@/server/photography-photos";
import type { Picture } from "@/server/media";
import { requireStaff } from "@/server/session";
import { loadSettings } from "@/server/settings";
import { formatRange, localDateOf } from "@/server/tz";
import { AdminFrame, AdminLoading } from "../frame";
import {
  addPhotographyPhotosAction,
  blockPhotographerAction,
  blockPhotographerDaysAction,
  movePhotographyPhotoEarlierAction,
  movePhotographyPhotoLaterAction,
  removePhotographyPhotoAction,
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
  const owner = viewer.role === "owner";
  const [photographer, blocks, packages, photos, showing] = await Promise.all([
    loadPhotographer(db),
    listPhotographerBlocks(db, now),
    owner ? listPhotoPackages(db) : [],
    owner ? loadPhotographyPhotos(db) : [],
    owner ? pagesShowingPhotographyPhotos(db) : [],
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
        {viewer.role === "owner" && (
          <p style={{ fontSize: ".875rem", margin: ".75rem 0 0" }}>
            The photographer can set her working hours and days off herself: add her under{" "}
            <Link href="/admin/staff">Staff</Link> as a Studio Attendant, and switch on &ldquo;Set the hours the photographer
            works, and block their time&rdquo; under &ldquo;What Studio Attendants can do&rdquo; (it applies to every attendant).
          </p>
        )}
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
              Time when the photographer cannot take a session: days off, a holiday, a job elsewhere. Clients are offered
              no session then.
            </p>
            <h4 id="photo-days-off">Whole days off</h4>
            <form action={blockPhotographerDaysAction} className="admin-form-row" aria-labelledby="photo-days-off">
              <div className="form-group">
                <label className="form-label" htmlFor="photo-days-from">
                  First day off
                </label>
                <input id="photo-days-from" name="from" type="date" className="form-control" min={localDateOf(now)} required />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="photo-days-to">
                  Last day off (empty for one day)
                </label>
                <input id="photo-days-to" name="to" type="date" className="form-control" min={localDateOf(now)} />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="photo-days-note">
                  Note
                </label>
                <input id="photo-days-note" name="note" className="form-control" maxLength={200} />
              </div>
              <button type="submit" className="btn btn-dark btn-small">
                Block whole days
              </button>
            </form>
            <h4 id="photo-hours-off">Some hours of one day</h4>
            <form action={blockPhotographerAction} className="admin-form-row" aria-labelledby="photo-hours-off">
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
                          <td>{block.days ? `${block.days.from === block.days.to ? "Whole day" : "Whole days"}: ${daysText(block.days)}` : `${when.day}, ${when.time}`}</td>
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

      {owner && <PhotographyPhotos photos={photos} showing={showing} />}

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

/**
 * The photos the site shows for photography, in the owners' order (the owner's answer of 2026-11-23, question 73), and
 * the pages that show them: wherever a Gallery is set to them.
 */
function PhotographyPhotos({ photos, showing }: { photos: Picture[]; showing: { title: string; slug: string }[] }) {
  const last = photos.length - 1;
  return (
    <div className="admin-card" id="photography-photos">
      <h3>Photos</h3>
      <p style={{ fontSize: ".875rem" }}>
        From the media library, in this order. A change shows on the website at once, wherever a Gallery is set to
        &ldquo;The photos chosen under Admin → Photography&rdquo;. Up to {PHOTOGRAPHY_PHOTO_LIMIT}.
      </p>
      <p style={{ fontSize: ".875rem" }}>
        {showing.length === 0 ? (
          <>
            No published page shows them yet. To show them: Website → Pages, the page, add a Gallery, and choose &ldquo;The
            photos chosen under Admin → Photography&rdquo; under &ldquo;Which pictures&rdquo;.
          </>
        ) : (
          <>
            Shown on{" "}
            {showing.map((page, index) => (
              <span key={page.slug}>
                {index > 0 && (index === showing.length - 1 ? " and " : ", ")}
                <Link href={`/${page.slug}`}>{page.title || page.slug}</Link>
              </span>
            ))}
            .
          </>
        )}
      </p>
      {photos.length > 0 && (
        <ol className="media-ordered">
          {photos.map((photo, index) => (
            <li key={photo.id}>
              <Image src={photo.url} width={photo.width} height={photo.height} alt={photo.alt} sizes="160px" />
              <span className="media-facts">{photo.alt}</span>
              <span className="editor-row-buttons">
                <form action={movePhotographyPhotoEarlierAction}>
                  <input type="hidden" name="mediaId" value={photo.id} />
                  <button type="submit" className="btn btn-outline btn-small" disabled={index === 0} aria-label={`Move photo ${index + 1} earlier`}>
                    ↑
                  </button>
                </form>
                <form action={movePhotographyPhotoLaterAction}>
                  <input type="hidden" name="mediaId" value={photo.id} />
                  <button type="submit" className="btn btn-outline btn-small" disabled={index === last} aria-label={`Move photo ${index + 1} later`}>
                    ↓
                  </button>
                </form>
                <form action={removePhotographyPhotoAction}>
                  <input type="hidden" name="mediaId" value={photo.id} />
                  <button type="submit" className="btn btn-outline btn-small" aria-label={`Take off photo ${index + 1}`}>
                    Take off
                  </button>
                </form>
              </span>
            </li>
          ))}
        </ol>
      )}
      {photos.length < PHOTOGRAPHY_PHOTO_LIMIT && <ChoosePictures label="Add photos" action={addPhotographyPhotosAction} fields={{}} />}
    </div>
  );
}
