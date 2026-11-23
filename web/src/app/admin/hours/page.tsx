import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { can } from "@/lib/abilities";
import { minutesToHHMM, weekdayName } from "@/lib/domain/time";
import { loadCatalog } from "@/server/catalog";
import { requireManager } from "@/server/session";
import { saveHoursAction } from "../actions";
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
  const catalog = await loadCatalog(db);
  if (!can(viewer, "blockTime", catalog.settings)) notFound();
  const owner = viewer.role === "owner";

  return (
    <AdminFrame active="/admin/hours" title={owner ? "Hours" : "Blocked time"} query={await searchParams} viewer={viewer} settings={catalog.settings}>
      <div className="admin-card">
        <h3>Blocked time</h3>
        <p style={{ fontSize: ".875rem", marginBottom: 0 }}>
          Blocking a time, a day, several days or every week, in one studio or all of them, is under{" "}
          <Link href="/admin/availability">Availability &amp; Blocked Time</Link>.
        </p>
      </div>

      {(owner ? catalog.studios : []).map((studio) => (
        <div className="admin-card" key={studio.id}>
          <h3>{studio.name}: opening hours</h3>
          <form action={saveHoursAction}>
            <input type="hidden" name="studioId" value={studio.id} />
            <div className="data-table-wrap">
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
            </div>
            <button type="submit" className="btn btn-dark btn-small" style={{ marginTop: "1rem" }}>
              Save {studio.name} hours
            </button>
          </form>
        </div>
      ))}
    </AdminFrame>
  );
}
