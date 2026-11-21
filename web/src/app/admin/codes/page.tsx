import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/domain/pricing";
import { durationLabel } from "@/lib/domain/time";
import { EMAIL_FIELD, PROMO_CODE_FIELD } from "@/lib/parse";
import { listCodes } from "@/server/admin";
import { isBookingRef } from "@/server/bookings";
import { requireOwner } from "@/server/session";
import { formatInstant } from "@/server/tz";
import { createCodeAction, voidCodeAction } from "../actions";
import { petCreditAction } from "../appointments/actions";
import { CodeKindAndValue } from "./CodeKindAndValue";
import { AdminFrame, AdminLoading } from "../frame";

export const metadata: Metadata = { title: "Codes", robots: { index: false } };

const SOURCE_LABEL: Record<string, string> = {
  loyalty: "Earned by visits",
  reschedule: "Reschedule credit",
  manual: "Made by you",
  pet_fee: "Pet fee returned",
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

  return (
    <AdminFrame active="/admin/codes" title="Codes" query={query}>
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
                      <div style={{ fontSize: ".8rem" }}>{code.photographyOnly ? "Photography sessions" : "Studio rentals"}</div>
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
