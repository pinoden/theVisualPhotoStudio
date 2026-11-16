import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { longDateLabel } from "@/lib/domain/time";
import { ADMIN_LEVELS, ATTENDANT_SWITCH_KEYS, ATTENDANT_SWITCHES, MANAGER_SWITCH_KEYS, MANAGER_SWITCHES } from "@/lib/abilities";
import { listStaff } from "@/server/admin";
import { requireOwner } from "@/server/session";
import { loadSettings } from "@/server/settings";
import { localDateOf } from "@/server/tz";
import {
  addStaffAction,
  removeStaffAction,
  saveManagerAbilitiesAction,
  saveStaffAbilitiesAction,
  setStaffLevelAction,
  shiftAction,
} from "../actions";
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
        <p style={{ fontSize: ".875rem" }}>
          The admin has three levels. Everyone signs in with their email address.
        </p>
        <ul style={{ fontSize: ".875rem", margin: 0 }}>
          <li>
            <strong>Owners</strong> have all of it. You are an owner because your address is in the site&rsquo;s
            configuration, which this page cannot change.
          </li>
          <li>
            <strong>Studio Managers</strong> run the appointments and look after clients. A manager always sees every
            day and its contact details, changes status labels, moves a booking, makes a booking for a client and
            sets the photographer&rsquo;s time. The switches below decide the rest.
          </li>
          <li>
            <strong>Studio Attendants</strong> get the calendar, the day sheet and the appointments of the days you
            assign them, for check-ins and status labels. The switches below decide what else.
          </li>
        </ul>
        <p style={{ fontSize: ".875rem", margin: ".75rem 0 0" }}>
          Prices, studios and add-ons, opening hours, codes, these switches and the settings stay with the owners.
        </p>
      </div>

      <form action={saveManagerAbilitiesAction} className="admin-card">
        <h3>What Studio Managers can do</h3>
        {MANAGER_SWITCH_KEYS.map((ability) => (
          <label key={ability} style={{ display: "block", marginBottom: ".5rem", fontSize: ".9rem" }}>
            <input type="checkbox" name={ability} defaultChecked={settings[ability]} /> {MANAGER_SWITCHES[ability]}
          </label>
        ))}
        <div style={{ fontSize: ".78rem", margin: ".5rem 0 1rem" }}>
          A change applies at once, to every manager. Nothing has to be redeployed.
        </div>
        <button type="submit" className="btn btn-dark btn-small">
          Save what managers can do
        </button>
      </form>

      <form action={saveStaffAbilitiesAction} className="admin-card">
        <h3>What Studio Attendants can do</h3>
        {ATTENDANT_SWITCH_KEYS.map((ability) => (
          <label key={ability} style={{ display: "block", marginBottom: ".5rem", fontSize: ".9rem" }}>
            <input type="checkbox" name={ability} defaultChecked={settings[ability]} /> {ATTENDANT_SWITCHES[ability]}
          </label>
        ))}
        <div style={{ fontSize: ".78rem", margin: ".5rem 0 1rem" }}>
          A change applies at once, to every attendant. Nothing has to be redeployed.
        </div>
        <button type="submit" className="btn btn-dark btn-small">
          Save what attendants can do
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
          <div className="form-group">
            <label className="form-label" htmlFor="staff-level">
              Level
            </label>
            <select id="staff-level" name="level" className="form-control" defaultValue="staff" required>
              {Object.entries(ADMIN_LEVELS).map(([key, title]) => (
                <option key={key} value={key}>
                  {title}
                </option>
              ))}
            </select>
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
            {person.name && <span style={{ fontFamily: "var(--font-sans)", fontSize: ".8rem" }}>{person.email}</span>}{" "}
            <span className="status-badge status-confirmed">{ADMIN_LEVELS[person.level]}</span>
          </h3>
          <div style={{ marginBottom: "1rem" }}>
            {person.level === "manager" && <span style={{ fontSize: ".875rem" }}>A manager sees every day: none has to be assigned.</span>}
            {person.level === "staff" && person.days.length === 0 && (
              <span style={{ fontSize: ".875rem" }}>No days assigned: this person sees nothing.</span>
            )}
            {(person.level === "staff" ? person.days : []).map((day) => (
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
            {person.level === "staff" && (
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
            )}
            <form action={setStaffLevelAction} className="admin-form-row" style={{ marginBottom: 0 }}>
              <input type="hidden" name="userId" value={person.id} />
              <div className="form-group">
                <label className="form-label" htmlFor={`level-${person.id}`}>
                  Level
                </label>
                <select id={`level-${person.id}`} name="level" className="form-control" defaultValue={person.level}>
                  {Object.entries(ADMIN_LEVELS).map(([key, title]) => (
                    <option key={key} value={key}>
                      {title}
                    </option>
                  ))}
                </select>
              </div>
              <button type="submit" className="btn btn-outline btn-small">
                Change level
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
