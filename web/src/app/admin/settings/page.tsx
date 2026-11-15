import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { requireOwner } from "@/server/session";
import { ACCESS_INSTRUCTIONS_MAX, loadAccessInstructions, loadSettings, type Settings } from "@/server/settings";
import { saveAccessInstructionsAction, saveSettingsAction } from "../actions";
import { AdminFrame, AdminLoading } from "../frame";

export const metadata: Metadata = { title: "Settings", robots: { index: false } };

type NumberKey = {
  [K in keyof Settings]: Settings[K] extends number ? K : never;
}[keyof Settings];

const GROUPS: { title: string; fields: { key: NumberKey; label: string; help: string }[] }[] = [
  {
    title: "Booking",
    fields: [
      { key: "minLeadHours", label: "Minimum notice (hours)", help: "How far ahead a booking must be made." },
      { key: "maxAdvanceDays", label: "Booking horizon (days)", help: "How far ahead the calendar is open." },
      { key: "slotIncrementMinutes", label: "Start times every (minutes)", help: "30 offers 9:00, 9:30, 10:00 and so on." },
      { key: "holdMinutes", label: "Hold while paying (minutes)", help: "How long a slot is kept for a customer at checkout." },
    ],
  },
  {
    title: "Cancelling and rescheduling",
    fields: [
      { key: "refundWindowHours", label: "Refund window (hours before start)", help: "168 is 7 days. Earlier cancellations are refunded automatically." },
      { key: "refundFeePercent", label: "Processing fee kept (%)", help: "0 refunds in full." },
      { key: "rescheduleCutoffHours", label: "Reschedule cut-off (hours before start)", help: "After this, customers must call." },
      { key: "maxReschedules", label: "Reschedules allowed per booking", help: "0 switches reschedule codes off." },
      { key: "creditValidDays", label: "Reschedule code valid for (days)", help: "" },
    ],
  },
  {
    title: "Loyalty code after a visit",
    fields: [
      { key: "loyaltyPercent", label: "Discount (%)", help: "Off the studio rental of the next booking." },
      { key: "loyaltyValidDays", label: "Valid for (days)", help: "" },
      { key: "loyaltyDelayHours", label: "Send after (hours)", help: "Time after the visit ends, so staff can mark a no-show first." },
    ],
  },
];

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
          their confirmation email and see it on their booking page. It is never shown on a public page. Leave it
          empty to send nothing.
        </div>
        <button type="submit" className="btn btn-dark btn-small">
          Save getting-in text
        </button>
      </form>

      <form action={saveSettingsAction}>
        {GROUPS.map((group) => (
          <div className="admin-card" key={group.title}>
            <h3>{group.title}</h3>
            {group.title.startsWith("Loyalty") && (
              <label style={{ display: "block", marginBottom: "1rem", fontSize: ".9rem" }}>
                <input type="checkbox" name="loyaltyEnabled" defaultChecked={settings.loyaltyEnabled} /> Send a loyalty code
                after each completed visit
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
                    inputMode="numeric"
                    defaultValue={settings[field.key]}
                    required
                  />
                  {field.help && <div style={{ fontSize: ".78rem", marginTop: ".25rem" }}>{field.help}</div>}
                </div>
              ))}
            </div>
          </div>
        ))}

        <div className="admin-card">
          <h3>Staff</h3>
          <label style={{ fontSize: ".9rem" }}>
            <input type="checkbox" name="staffSeesContact" defaultChecked={settings.staffSeesContact} /> Staff can see
            customers&rsquo; phone numbers and email addresses on the day sheet
          </label>
        </div>

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
