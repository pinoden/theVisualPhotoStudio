import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { centsToInput, FEE_FIELD } from "@/lib/parse";
import { ownerNotifyEmail } from "@/server/runtime";
import { requireOwner } from "@/server/session";
import { ACCESS_INSTRUCTIONS_MAX, loadAccessInstructions, loadContactInbox, loadSettings, NUMBER_SETTING_RANGES } from "@/server/settings";
import { formatInstant } from "@/server/tz";
import { saveAccessInstructionsAction, saveContactInboxAction, saveSettingsAction } from "../actions";
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
  const [settings, access, inbox] = await Promise.all([loadSettings(db), loadAccessInstructions(db), loadContactInbox(db)]);
  const notices = ownerNotifyEmail();

  return (
    <AdminFrame active="/admin/settings" title="Settings" query={await searchParams}>
      <form action={saveContactInboxAction} className="admin-card" id="contact-inbox">
        <h3>Messages from the contact form</h3>
        <label className="form-label" htmlFor="contactInbox">
          Send them to
        </label>
        <input id="contactInbox" name="contactInbox" type="email" className="form-control" maxLength={200} defaultValue={inbox} autoComplete="off" />
        <div style={{ fontSize: ".78rem", margin: ".25rem 0 1rem" }}>
          The inbox that gets what visitors write on the Contact page, such as hello@. A reply goes straight to the
          visitor. {inbox ? `Now: ${inbox}.` : notices ? `Empty, so they go where the site's notices go: ${notices}.` : "Empty, and no address for the site's notices is set: messages cannot be sent."}
        </div>
        <button type="submit" className="btn btn-dark btn-small">
          Save the address
        </button>
      </form>

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
              <>
                <label style={{ display: "block", marginBottom: ".4rem", fontSize: ".9rem" }}>
                  <input type="checkbox" name="loyaltyEnabled" defaultChecked={settings.loyaltyEnabled} /> Email a free
                  hour to customers when their visits have earned one
                </label>
                <p style={{ fontSize: ".78rem", margin: "0 0 1rem" }}>
                  Switching this off and on again starts every customer&rsquo;s stamps from nothing. Free hours already
                  sent stay valid.
                  {settings.loyaltyStartedAt && <> Stamps are counted from {formatInstant(new Date(settings.loyaltyStartedAt))}.</>}
                </p>
              </>
            )}
            {group.title === "Cancelling and rescheduling" && (
              <>
                <label style={{ display: "block", marginBottom: ".4rem", fontSize: ".9rem" }}>
                  <input type="checkbox" name="cancelCodeEnabled" defaultChecked={settings.cancelCodeEnabled} /> A late cancellation gets a credit
                  code
                </label>
                <p style={{ fontSize: ".78rem", margin: "0 0 1rem" }}>
                  On, a client who cancels inside the refund window but at least the hours above before the start gets what they paid as a code
                  for a new booking, valid as long as a reschedule code; nothing goes back to the card. Switch it off for a busy season: a late
                  cancellation then gets nothing. Either way, a cancellation closer to the start gets nothing, and an owner can still refund an
                  emergency from the booking (Bookings, Refund). A booking keeps the rule it was made under.
                </p>
                <label style={{ display: "block", marginBottom: ".4rem", fontSize: ".9rem" }}>
                  <input type="checkbox" name="lateCancelKeepsCode" defaultChecked={settings.lateCancelKeepsCode} /> A discount code, free
                  hour or studio credit comes back after any cancellation
                </label>
                <p style={{ fontSize: ".78rem", margin: "0 0 1rem" }}>
                  Off, it comes back only when the client cancels in time for a refund: cancelled later, or after the booking was moved, a
                  code is used up, as money paid is kept then, and studio credit is not given back by itself: the client is asked to contact the
                  studio, and you decide each case (Codes gives credit back). A cancellation by the studio always gives it back. A booking keeps the rule it was
                  made under.
                </p>
                <label style={{ display: "block", marginBottom: ".4rem", fontSize: ".9rem" }}>
                  <input type="checkbox" name="weekdayCodeOnWeekdays" defaultChecked={settings.weekdayCodeOnWeekdays} /> A studio rental booked for
                  a weekday is moved to a weekday only
                </label>
                <p style={{ fontSize: ".78rem", margin: "0 0 1rem" }}>
                  On, the code a client gets for releasing such a booking works Monday to Friday and not on the dates under Prices, &ldquo;Holidays and
                  special dates&rdquo;. A booking made for a weekend or a holiday gets a code for any day, and so does a session. The studio can still move
                  a booking to any day from the calendar. Off, every code is for any day. A booking keeps the rule it was made under.
                </p>
              </>
            )}
            {group.title === "Memberships" && (
              <>
                <label style={{ display: "block", marginBottom: ".4rem", fontSize: ".9rem" }}>
                  <input type="checkbox" name="memberWeekendDifference" defaultChecked={settings.memberWeekendDifference} /> At
                  weekends, members pay the difference to the weekend price
                </label>
                <p style={{ fontSize: ".78rem", margin: "0 0 1rem" }}>
                  Their hours then cover the weekday price of the time, and they pay the rest of the weekend price. Off, their
                  hours cover weekend time in full.
                </p>
              </>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "1rem" }}>
              {group.fields.map((field) => (
                <div className="form-group" key={field.key} style={{ marginBottom: 0 }}>
                  <label className="form-label" htmlFor={field.key}>
                    {field.label}
                  </label>
                  {field.money ? (
                    <input
                      id={field.key}
                      name={field.key}
                      className="form-control"
                      defaultValue={centsToInput(settings[field.key])}
                      maxLength={12}
                      {...FEE_FIELD}
                      required
                    />
                  ) : (
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
                  )}
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
