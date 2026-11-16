import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { requireManager } from "@/server/session";
import { loadSettings } from "@/server/settings";
import { formatInstant } from "@/server/tz";
import { DESIGN_DOC, FRAME_DOC, loadForEditing, type EditingState } from "@/server/website";
import { AdminFrame, AdminLoading } from "../frame";

export const metadata: Metadata = { title: "Website", robots: { index: false } };

export default function WebsitePage(props: PageProps<"/admin/website">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Website searchParams={props.searchParams} />
    </Suspense>
  );
}

/** Where a part of the website stands: changed and not published, published, or still as it was built. */
function State({ state }: { state: EditingState<unknown> }) {
  if (state.hasDraft) {
    return (
      <p className="website-state">
        <strong>Unpublished changes.</strong>
        {state.draftAt && ` Last saved ${formatInstant(new Date(state.draftAt))}${state.draftBy ? ` by ${state.draftBy}` : ""}.`} Visitors
        do not see them yet.
      </p>
    );
  }
  if (state.publishedAt) {
    return (
      <p className="website-state">
        Published {formatInstant(new Date(state.publishedAt))}
        {state.publishedBy ? ` by ${state.publishedBy}` : ""}.
      </p>
    );
  }
  return <p className="website-state">As the site was built. Nothing has been changed here yet.</p>;
}

/**
 * The website's editor: what of the public website can be changed from the
 * admin, and where each part stands. For the owners, and for a manager the
 * owners have let in (the switch "Change the website's design" on the Staff
 * page). Anyone else gets "not found".
 */
async function Website({ searchParams }: Pick<PageProps<"/admin/website">, "searchParams">) {
  await connection();
  const viewer = await requireManager("/admin/website");
  const db = await getDb();
  const [design, frame, settings] = await Promise.all([
    loadForEditing(db, viewer, DESIGN_DOC),
    loadForEditing(db, viewer, FRAME_DOC),
    loadSettings(db),
  ]);
  if (!design || !frame) notFound();
  const anyDraft = design.hasDraft || frame.hasDraft;

  return (
    <AdminFrame active="/admin/website" title="Website" query={await searchParams} viewer={viewer} settings={settings}>
      <div className="admin-card">
        <p style={{ margin: 0, fontSize: ".9rem" }}>
          What you change here is saved as a draft that only the admin sees. It reaches visitors when you press
          Publish, and every published version is kept, so an earlier one can be brought back.
          {!design.may.publish && " You can prepare drafts; an owner publishes them."}
        </p>
        {anyDraft && (
          <p style={{ margin: ".75rem 0 0" }}>
            {/* A plain link: this address switches the preview on, so it must not be fetched ahead of a click. */}
            <a href="/admin/website/preview?to=%2F" target="_blank" rel="noopener" className="btn btn-outline btn-small">
              See the website with the unpublished changes
            </a>
          </p>
        )}
      </div>

      <div className="website-cards">
        <section className="admin-card" aria-labelledby="website-design">
          <h3 id="website-design">Design</h3>
          <p>Colours, fonts, the size and weight of headings and text, buttons and spacing, for the whole website.</p>
          <State state={design} />
          <Link href="/admin/website/design" className="btn btn-dark btn-small">
            Edit the design
          </Link>
        </section>
        <section className="admin-card" aria-labelledby="website-frame">
          <h3 id="website-frame">Header, menu &amp; footer</h3>
          <p>
            The studio&rsquo;s name, address and phone, the logo, the menu and its booking button, the announcement
            bar, the footer and the social links.
          </p>
          <State state={frame} />
          <Link href="/admin/website/navigation" className="btn btn-dark btn-small">
            Edit the header, menu &amp; footer
          </Link>
        </section>
      </div>
    </AdminFrame>
  );
}
