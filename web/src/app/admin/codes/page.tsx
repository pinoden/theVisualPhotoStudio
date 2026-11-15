import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/domain/pricing";
import { durationLabel } from "@/lib/domain/time";
import { listCodes } from "@/server/admin";
import { requireOwner } from "@/server/session";
import { formatInstant } from "@/server/tz";
import { createCodeAction, voidCodeAction } from "../actions";
import { AdminFrame, AdminLoading } from "../frame";

export const metadata: Metadata = { title: "Codes", robots: { index: false } };

const SOURCE_LABEL: Record<string, string> = {
  loyalty: "Earned by visits",
  reschedule: "Reschedule credit",
  manual: "Made by you",
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

  return (
    <AdminFrame active="/admin/codes" title="Codes" query={await searchParams}>
      <div className="admin-card">
        <h3>Create a code</h3>
        <form action={createCodeAction} className="admin-form-row" style={{ marginBottom: 0 }}>
          <div className="form-group">
            <label className="form-label" htmlFor="code-kind">
              Kind
            </label>
            <select id="code-kind" name="kind" className="form-control" defaultValue="percent">
              <option value="percent">Percent off the rental</option>
              <option value="amount">Credit in dollars</option>
              <option value="free_hour">One free hour (one studio)</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="code-value">
              Value (% or $; none for a free hour)
            </label>
            <input id="code-value" name="value" className="form-control" inputMode="decimal" />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="code-email">
              Only for email (optional)
            </label>
            <input id="code-email" name="email" type="email" className="form-control" />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="code-days">
              Valid for (days)
            </label>
            <input id="code-days" name="validDays" className="form-control" inputMode="numeric" defaultValue="30" required />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="code-uses">
              Uses (not for credit)
            </label>
            <input id="code-uses" name="maxUses" className="form-control" inputMode="numeric" defaultValue="1" />
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
