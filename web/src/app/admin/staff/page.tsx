import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { longDateLabel } from "@/lib/domain/time";
import { STAFF_ABILITIES, STAFF_ABILITY_KEYS } from "@/lib/staff-abilities";
import { listStaff } from "@/server/admin";
import { requireOwner } from "@/server/session";
import { loadSettings } from "@/server/settings";
import { localDateOf } from "@/server/tz";
import { addStaffAction, removeStaffAction, saveStaffAbilitiesAction, shiftAction } from "../actions";
import { AdminFrame, AdminLoading } from "../frame";

export const metadata: Metadata = { title: "Staff", robots: { index: false } };

export default function StaffAdminPage(props: PageProps<"/admin/staff">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Staff searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Staff({ searchParams }: Pick<PageProps<"/admin/staff">, "searchParams">) {
  await connection();
  await requireOwner("/admin/staff");
  const today = localDateOf(new Date());
  const db = await getDb();
  const [staff, settings] = await Promise.all([listStaff(db, today), loadSettings(db)]);

  return (
    <AdminFrame active="/admin/staff" title="Staff" query={await searchParams}>
      <div className="admin-card">
        <h3>How staff access works</h3>
        <p style={{ fontSize: ".875rem", margin: 0 }}>
          The admin has two levels. You, the owners, have all of it. A staff member signs in with their email address
          and gets the day sheet and the appointments of the days you assign here: times, studios, customer names,
          add-ons and notes. What else they can see and do is set by the switches below. They never see revenue, the
          customer list, prices to edit, codes or these settings.
        </p>
      </div>

      <form action={saveStaffAbilitiesAction} className="admin-card">
        <h3>What staff can do</h3>
        {STAFF_ABILITY_KEYS.map((ability) => (
          <label key={ability} style={{ display: "block", marginBottom: ".5rem", fontSize: ".9rem" }}>
            <input type="checkbox" name={ability} defaultChecked={settings[ability]} /> {STAFF_ABILITIES[ability]}
          </label>
        ))}
        <div style={{ fontSize: ".78rem", margin: ".5rem 0 1rem" }}>
          A change applies at once, to every member of staff. Nothing has to be redeployed.
        </div>
        <button type="submit" className="btn btn-dark btn-small">
          Save what staff can do
        </button>
      </form>

      <div className="admin-card">
        <h3>Add a staff member</h3>
        <form action={addStaffAction} className="admin-form-row">
          <div className="form-group">
            <label className="form-label" htmlFor="staff-email">
              Email
            </label>
            <input id="staff-email" name="email" type="email" className="form-control" required />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="staff-name">
              Name
            </label>
            <input id="staff-name" name="name" className="form-control" maxLength={120} />
          </div>
          <button type="submit" className="btn btn-dark btn-small">
            Add
          </button>
        </form>
      </div>

      {staff.length === 0 && <div className="admin-card">No staff yet.</div>}
      {staff.map((person) => (
        <div className="admin-card" key={person.id}>
          <h3>
            {person.name || person.email}{" "}
            {person.name && <span style={{ fontFamily: "var(--font-sans)", fontSize: ".8rem" }}>{person.email}</span>}
          </h3>
          <div style={{ marginBottom: "1rem" }}>
            {person.days.length === 0 && <span style={{ fontSize: ".875rem" }}>No days assigned: this person sees nothing.</span>}
            {person.days.map((day) => (
              <form action={shiftAction} key={day} className="chip">
                <input type="hidden" name="userId" value={person.id} />
                <input type="hidden" name="day" value={day} />
                <input type="hidden" name="assigned" value="0" />
                {day === today ? "Today" : longDateLabel(day)}
                <button type="submit" aria-label={`Remove ${longDateLabel(day)}`}>
                  ×
                </button>
              </form>
            ))}
          </div>
          <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
            <form action={shiftAction} className="admin-form-row" style={{ marginBottom: 0 }}>
              <input type="hidden" name="userId" value={person.id} />
              <input type="hidden" name="assigned" value="1" />
              <div className="form-group">
                <label className="form-label" htmlFor={`day-${person.id}`}>
                  Assign a day
                </label>
                <input id={`day-${person.id}`} name="day" type="date" className="form-control" min={today} required />
              </div>
              <button type="submit" className="btn btn-dark btn-small">
                Assign
              </button>
            </form>
            <form action={removeStaffAction}>
              <input type="hidden" name="userId" value={person.id} />
              <button type="submit" className="btn btn-outline btn-small">
                Remove staff access
              </button>
            </form>
          </div>
        </div>
      ))}
    </AdminFrame>
  );
}
