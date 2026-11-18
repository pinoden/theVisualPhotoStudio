import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/domain/pricing";
import { centsToInput, CHARGE_FIELD } from "@/lib/parse";
import { loadCatalog } from "@/server/catalog";
import { listPlans, PLAN_DESCRIPTION_MAX, PLAN_NAME_MAX, planStudioChoices, type PlanView } from "@/server/memberships";
import { requireOwner } from "@/server/session";
import { AdminFrame, AdminLoading } from "../frame";
import { addPlanAction, offerPlanAgainAction, savePlanAction, stopOfferingPlanAction } from "./actions";

export const metadata: Metadata = { title: "Memberships", robots: { index: false } };

export default function MembershipsAdminPage(props: PageProps<"/admin/memberships">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Memberships searchParams={props.searchParams} />
    </Suspense>
  );
}

const HELP = { fontSize: ".78rem", marginTop: ".25rem" } as const;

/** The fields of one plan. `id` keeps the field ids on the page apart: the plan's id, or "new". */
function PlanFields({ id, plan }: { id: string; plan?: PlanView }) {
  return (
    <>
      <div className="admin-form-row">
        <div className="form-group" style={{ flex: "2 1 16rem" }}>
          <label className="form-label" htmlFor={`plan-${id}-name`}>
            Name
          </label>
          <input id={`plan-${id}-name`} name="name" className="form-control" maxLength={PLAN_NAME_MAX} defaultValue={plan?.name ?? ""} required />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor={`plan-${id}-hours`}>
            Hours a month
          </label>
          <input
            id={`plan-${id}-hours`}
            name="hours"
            type="number"
            min={0.5}
            max={100}
            step={0.5}
            className="form-control price-input"
            defaultValue={plan ? plan.minutes / 60 : ""}
            required
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor={`plan-${id}-price`}>
            Price a month ($)
          </label>
          <input
            id={`plan-${id}-price`}
            name="price"
            className="form-control price-input"
            {...CHARGE_FIELD}
            defaultValue={plan ? centsToInput(plan.priceCents) : ""}
            required
          />
        </div>
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor={`plan-${id}-description`}>
          Description
        </label>
        <textarea
          id={`plan-${id}-description`}
          name="description"
          className="form-control"
          rows={2}
          maxLength={PLAN_DESCRIPTION_MAX}
          defaultValue={plan?.description ?? ""}
        />
      </div>
    </>
  );
}

async function Memberships({ searchParams }: Pick<PageProps<"/admin/memberships">, "searchParams">) {
  await connection();
  await requireOwner("/admin/memberships");
  const db = await getDb();
  const [plans, catalog] = await Promise.all([listPlans(db), loadCatalog(db)]);
  const choices = planStudioChoices(catalog.studios);

  return (
    <AdminFrame active="/admin/memberships" title="Memberships" query={await searchParams}>
      <div className="notice notice-warning" role="status">
        Clients cannot buy a membership on the site yet: buying one online, with the card billed each month by Square, is
        being built. The plans below are what it will offer.
      </div>
      <div className="admin-card">
        <h3>Plans</h3>
        <p style={HELP}>
          Each plan gives studio hours every month for a monthly price, in one studio or in the studios of a bundle,
          which members can use in any one of them too. A new price or number of hours applies to members who join
          after it. A plan no longer offered stays with the members who have it.
        </p>
        {plans.map((plan) => (
          <form action={savePlanAction} key={plan.id} className="membership-plan">
            <input type="hidden" name="planId" value={plan.id} />
            <p className="membership-plan-studios">
              <strong>{plan.studios.map((studio) => studio.name).join(" and ")}</strong>: {formatCents(plan.priceCents)} a month
              for {plan.minutes / 60} hours
              {!plan.active && <span className="badge badge-cancelled">Not offered</span>}
            </p>
            <PlanFields id={plan.id} plan={plan} />
            <div style={{ display: "flex", gap: ".75rem", flexWrap: "wrap" }}>
              <button type="submit" className="btn btn-dark btn-small">
                Save {plan.name}
              </button>
              <button type="submit" formAction={plan.active ? stopOfferingPlanAction : offerPlanAgainAction} className="btn btn-outline btn-small">
                {plan.active ? `Stop offering ${plan.name}` : `Offer ${plan.name} again`}
              </button>
            </div>
          </form>
        ))}

        <form action={addPlanAction} className="membership-plan">
          <h3>Add a plan</h3>
          <div className="form-group">
            <label className="form-label" htmlFor="plan-new-studios">
              For
            </label>
            <select id="plan-new-studios" name="studios" className="form-control" required defaultValue="">
              <option value="" disabled>
                Choose a studio or a bundle
              </option>
              {choices.map((choice) => (
                <option key={choice.ids.join(",")} value={choice.ids.join(",")}>
                  {choice.label}
                </option>
              ))}
            </select>
            <div style={HELP}>A plan&apos;s studios stay as they are made: they are what its members buy.</div>
          </div>
          <PlanFields id="new" />
          <button type="submit" className="btn btn-dark btn-small">
            Add plan
          </button>
        </form>
      </div>
    </AdminFrame>
  );
}
