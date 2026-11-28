import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/domain/pricing";
import { durationLabel } from "@/lib/domain/time";
import { EMAIL_FIELD, PROMO_CODE_FIELD } from "@/lib/parse";
import { BalanceCard } from "@/components/CodeBalanceCheck";
import { listCodes } from "@/server/admin";
import { isBookingRef } from "@/server/bookings";
import { normalizeCode } from "@/server/promos";
import { studioCodeCheck, type StudioCodeCheck } from "@/server/code-balance";
import { requireOwner } from "@/server/session";
import { formatInstant } from "@/server/tz";
import { createCodeAction, voidCodeAction } from "../actions";
import { petCreditAction } from "../appointments/actions";
import { CodeKindAndValue } from "./CodeKindAndValue";
import { AdminFrame, AdminLoading } from "../frame";

export const metadata: Metadata = { title: "Codes", robots: { index: false } };

const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const SOURCE_LABEL: Record<string, string> = {
  loyalty: "Earned by visits",
  reschedule: "Reschedule credit",
  manual: "Made by you",
  pet_fee: "Pet fee returned",
  cancel: "Late cancellation's credit",
  membership: "A membership",
};

const BOOKING_STATUS: Record<string, string> = {
  confirmed: "Confirmed",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "Missed",
  pending_payment: "Payment in progress",
  expired: "Not completed",
};

export default function CodesPage(props: PageProps<"/admin/codes">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Codes searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Codes({ searchParams }: Pick<PageProps<"/admin/codes">, "searchParams">) {
  await connection();
  await requireOwner("/admin/codes");
  const now = new Date();
  const codes = await listCodes(await getDb());
  const query = await searchParams;
  const bookingRef = typeof query.booking === "string" && isBookingRef(query.booking) ? query.booking : "";
  const asked = typeof query.check === "string" ? normalizeCode(query.check) : "";
  const checked = asked ? await studioCodeCheck(await getDb(), asked, now) : null;

  return (
    <AdminFrame active="/admin/codes" title="Codes" query={query}>
      <div className="admin-card" id="code-check">
        <h3>Check a code&rsquo;s balance</h3>
        <p style={{ fontSize: ".875rem" }}>
          Any code of the site: studio credit, a reschedule code, a free hour, a discount or a membership. Checking spends
          nothing. Clients can check their own on the booking page.
        </p>
        <form action="/admin/codes#code-check" className="admin-form-row" style={{ marginBottom: 0 }}>
          <div className="form-group">
            <label className="form-label" htmlFor="code-check-code">
              Code
            </label>
            <input
              id="code-check-code"
              name="check"
              className="form-control"
              defaultValue={asked}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={40}
              required
            />
          </div>
          <button type="submit" className="btn btn-dark btn-small">
            Check balance
          </button>
        </form>
        {asked && (
          <div role="status" style={{ marginTop: "1rem" }}>
            {checked ? <CheckedCode checked={checked} /> : <p className="flash flash-error">There is no code {asked}.</p>}
          </div>
        )}
      </div>

      <div className="admin-card">
        <h3>Create a code</h3>
        <form action={createCodeAction} className="admin-form-row" style={{ marginBottom: 0 }}>
          <CodeKindAndValue />
          <div className="form-group">
            <label className="form-label" htmlFor="code-text">
              Code (optional)
            </label>
            <input id="code-text" name="code" className="form-control" placeholder="Made up by the site" {...PROMO_CODE_FIELD} />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="code-email">
              Only for email (optional)
            </label>
            <input id="code-email" name="email" className="form-control" {...EMAIL_FIELD} />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="code-days">
              Valid for (days)
            </label>
            <input id="code-days" name="validDays" className="form-control" type="number" min={1} max={730} step={1} defaultValue="30" required />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="code-uses">
              Uses (discount codes only)
            </label>
            <input id="code-uses" name="maxUses" className="form-control" type="number" min={1} max={100000} step={1} defaultValue="1" />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="code-note">
              Note
            </label>
            <input id="code-note" name="note" className="form-control" maxLength={200} />
          </div>
          <fieldset className="admin-fieldset code-days">
            <legend className="form-label">Booking days (optional)</legend>
            <p className="code-days-help">
              The days a booking with this code may be on: a season, some days of the week, not on holidays. &ldquo;Valid for&rdquo; is how long
              clients can enter it; a client who books outside these days is told which days it is for, and keeps the code.
            </p>
            <div className="admin-form-row" style={{ marginBottom: ".5rem" }}>
              <div className="form-group">
                <label className="form-label" htmlFor="code-days-from">
                  First booking day
                </label>
                <input id="code-days-from" name="daysFrom" type="date" className="form-control" />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="code-days-until">
                  Last booking day
                </label>
                <input id="code-days-until" name="daysUntil" type="date" className="form-control" />
              </div>
            </div>
            <div role="group" aria-label="Days of the week" className="code-days-week">
              {WEEKDAY_NAMES.map((name, i) => (
                <label key={name} className="admin-check">
                  <input type="checkbox" name="weekday" value={i + 1} defaultChecked /> {name}
                </label>
              ))}
            </div>
            <label className="admin-check">
              <input type="checkbox" name="notOnSpecialDates" value="1" /> Not on holidays and special dates (the dates under{" "}
              <Link href="/admin/prices">Prices</Link>)
            </label>
          </fieldset>
          <button type="submit" className="btn btn-dark btn-small">
            Create
          </button>
        </form>
      </div>

      <div className="admin-card" id="pet-fee-credit">
        <h3>Return a pet fee as studio credit</h3>
        <p>Use this once you know the pet did not attend. The client receives the credit code by email.</p>
        <form action={petCreditAction} className="admin-form-row" style={{ marginBottom: 0 }}>
          <div className="form-group">
            <label className="form-label" htmlFor="pet-credit-booking">Booking reference</label>
            <input
              id="pet-credit-booking"
              name="ref"
              className="form-control"
              defaultValue={bookingRef}
              pattern="[Vv][Ss]-[A-Za-z0-9]{6}"
              maxLength={9}
              autoCapitalize="characters"
              required
            />
          </div>
          <button type="submit" className="btn btn-dark btn-small">Issue studio credit</button>
        </form>
      </div>

      {codes.length === 0 ? (
        <div className="admin-card">No codes yet. Free hours and reschedule codes appear here as they are issued.</div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Worth</th>
                <th>Origin</th>
                <th>For</th>
                <th>Used</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {codes.map((code) => {
                const expired = code.expiresAt !== null && new Date(code.expiresAt) <= now;
                const spent = code.kind === "amount" ? code.value <= 0 : code.usedCount >= code.maxUses;
                const live = !code.voided && !expired && !spent;
                return (
                  <tr key={code.id}>
                    <td>
                      <strong style={{ color: "var(--color-dark)" }}>{code.code}</strong>
                      <div style={{ fontSize: ".8rem" }}>{code.photographyOnly ? "Photography and content creation sessions" : "Studio rentals"}</div>
                      {code.days && <div style={{ fontSize: ".8rem" }}>For {code.days}</div>}
                      {code.note && <div style={{ fontSize: ".8rem" }}>{code.note}</div>}
                    </td>
                    <td>
                      {code.kind === "percent"
                        ? `${code.value}%`
                        : code.kind === "free_hour"
                          ? `${durationLabel(code.value)} free`
                          : `${formatCents(code.value)} left`}
                    </td>
                    <td>{SOURCE_LABEL[code.source] ?? code.source}</td>
                    <td>{code.email ?? "Anyone"}</td>
                    <td>{code.kind === "amount" ? `${code.usedCount} times` : `${code.usedCount} of ${code.maxUses}`}</td>
                    <td>{code.expiresAt ? formatInstant(new Date(code.expiresAt)) : "Never"}</td>
                    <td>
                      {live ? (
                        <form action={voidCodeAction}>
                          <input type="hidden" name="codeId" value={code.id} />
                          <button type="submit" className="btn btn-outline btn-small">
                            Cancel code
                          </button>
                        </form>
                      ) : (
                        <span className="badge badge-cancelled">{code.voided ? "Cancelled" : expired ? "Expired" : "Used"}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </AdminFrame>
  );
}

/** The client's card for the code, then what only the studio sees: whose it is, where it came from, what it paid for. */
function CheckedCode({ checked }: { checked: StudioCodeCheck }) {
  return (
    <>
      <BalanceCard balance={checked.balance} />
      <dl className="detail-list" style={{ marginTop: "1rem" }}>
        <dt>Works with</dt>
        <dd>
          {checked.whose ? <Link href={`/admin/customers/${encodeURIComponent(checked.whose)}`}>{checked.whose}</Link> : "Any email address"}
        </dd>
        <dt>Origin</dt>
        <dd>
          {SOURCE_LABEL[checked.origin] ?? checked.origin}
          {checked.originRef && (
            <>
              {", for "}
              <Link href={`/admin/appointments/${encodeURIComponent(checked.originRef)}`}>{checked.originRef}</Link>
            </>
          )}
        </dd>
        {checked.issued && (
          <>
            <dt>Issued</dt>
            <dd>{checked.issued}</dd>
          </>
        )}
        <dt>Made</dt>
        <dd>{formatInstant(new Date(checked.madeAt))}</dd>
        {checked.cancelledAt && (
          <>
            <dt>Cancelled</dt>
            <dd>{formatInstant(new Date(checked.cancelledAt))}</dd>
          </>
        )}
        {checked.note && (
          <>
            <dt>Note</dt>
            <dd>{checked.note}</dd>
          </>
        )}
        <dt>Used for</dt>
        <dd>
          {checked.uses.length === 0 ? (
            "No booking yet."
          ) : (
            <ul className="code-uses">
              {checked.uses.map((use) => (
                <li key={use.ref}>
                  <Link href={`/admin/appointments/${encodeURIComponent(use.ref)}`}>{use.ref}</Link>, {use.customerName},{" "}
                  {formatInstant(new Date(use.startAt))} ({BOOKING_STATUS[use.status] ?? use.status}): {use.covered}
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>
    </>
  );
}
