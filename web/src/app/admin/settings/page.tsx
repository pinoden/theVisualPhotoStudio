import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { requireOwner } from "@/server/session";
import { ACCESS_INSTRUCTIONS_MAX, loadAccessInstructions, loadSettings, NUMBER_SETTING_RANGES } from "@/server/settings";
import { saveAccessInstructionsAction, saveSettingsAction } from "../actions";
import { AdminFrame, AdminLoading } from "../frame";
import { SETTING_GROUPS } from "./fields";

export const metadata: Metadata = { title: "Settings", robots: { index: false } };

export default function SettingsPage(props: PageProps<"/admin/settings">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <SettingsForm searchParams={props.searchParams} />
    </Suspense>
  );
}

async function SettingsForm({ searchParams }: Pick<PageProps<"/admin/settings">, "searchParams">) {
  await connection();
  await requireOwner("/admin/settings");
  const db = await getDb();
  const [settings, access] = await Promise.all([loadSettings(db), loadAccessInstructions(db)]);

  return (
    <AdminFrame active="/admin/settings" title="Settings" query={await searchParams}>
      <form action={saveAccessInstructionsAction} className="admin-card">
        <h3>Getting in</h3>
        <label className="form-label" htmlFor="accessInstructions">
          How customers get into the building
        </label>
        <textarea
          id="accessInstructions"
          name="accessInstructions"
          className="form-control"
          rows={4}
          maxLength={ACCESS_INSTRUCTIONS_MAX}
          defaultValue={access}
        />
        <div style={{ fontSize: ".78rem", margin: ".25rem 0 1rem" }}>
          For example the code for the building door and the floor. Customers with a confirmed booking get it in
          their confirmation email and see it on their booking page until their visit ends. It is never shown on a
          public page. Leave it empty to send nothing.
        </div>
        <button type="submit" className="btn btn-dark btn-small">
          Save getting-in text
        </button>
      </form>

      <form action={saveSettingsAction}>
        {SETTING_GROUPS.map((group) => (
          <div className="admin-card" key={group.title}>
            <h3>{group.title}</h3>
            {group.title.startsWith("Loyalty") && (
              <label style={{ display: "block", marginBottom: "1rem", fontSize: ".9rem" }}>
                <input type="checkbox" name="loyaltyEnabled" defaultChecked={settings.loyaltyEnabled} /> Email a free
                hour to customers when their visits have earned one
              </label>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "1rem" }}>
              {group.fields.map((field) => (
                <div className="form-group" key={field.key} style={{ marginBottom: 0 }}>
                  <label className="form-label" htmlFor={field.key}>
                    {field.label}
                  </label>
                  <input
                    id={field.key}
                    name={field.key}
                    className="form-control"
                    type="number"
                    min={NUMBER_SETTING_RANGES[field.key][0]}
                    max={NUMBER_SETTING_RANGES[field.key][1]}
                    step={1}
                    defaultValue={settings[field.key]}
                    required
                  />
                  {field.help && <div style={{ fontSize: ".78rem", marginTop: ".25rem" }}>{field.help}</div>}
                </div>
              ))}
            </div>
          </div>
        ))}

        <button type="submit" className="btn btn-dark">
          Save settings
        </button>
      </form>
      <p style={{ fontSize: ".8rem", marginTop: "1rem" }}>
        The discount for booking several studios together is on the Prices page.
      </p>
    </AdminFrame>
  );
}
