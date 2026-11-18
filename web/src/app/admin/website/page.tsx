import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { count } from "@/lib/words";
import { listCollections } from "@/server/collections";
import { listFonts } from "@/server/fonts";
import { listMedia } from "@/server/media";
import { pageCounts } from "@/server/pages";
import { requireManager } from "@/server/session";
import { loadSettings } from "@/server/settings";
import { formatInstant } from "@/server/tz";
import { DESIGN_DOC, FRAME_DOC, loadForEditing, websiteAbilities, type EditingState } from "@/server/website";
import { AdminFrame, AdminLoading } from "../frame";
import { WebsiteTabs } from "./tabs";

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
 * owners have let in: the design and the frame with "Change the website's
 * design", the pages with "Add and edit the website's pages". Each person sees
 * the parts they may open; anyone who may open none gets "not found".
 */
async function Website({ searchParams }: Pick<PageProps<"/admin/website">, "searchParams">) {
  await connection();
  const viewer = await requireManager("/admin/website");
  const db = await getDb();
  const may = await websiteAbilities(db, viewer);
  if (!may.editDesign && !may.editPages) notFound();
  const [design, frame, settings, pictures, collections, fonts, pages] = await Promise.all([
    may.editDesign ? loadForEditing(db, viewer, DESIGN_DOC) : null,
    may.editDesign ? loadForEditing(db, viewer, FRAME_DOC) : null,
    loadSettings(db),
    listMedia(db, viewer),
    listCollections(db, viewer),
    may.editDesign ? listFonts(db, viewer) : null,
    may.editPages ? pageCounts(db) : null,
  ]);
  const anyDraft = Boolean(design?.hasDraft || frame?.hasDraft || (pages && pages.waiting > 0));
  const undescribed = (pictures ?? []).filter((picture) => picture.alt === "").length;

  return (
    <AdminFrame active="/admin/website" title="Website" query={await searchParams} viewer={viewer} settings={settings}>
      <WebsiteTabs active="/admin/website" viewer={viewer} />
      <div className="admin-card">
        <p style={{ margin: 0, fontSize: ".9rem" }}>
          What you change here is saved as a draft that only the admin sees. It reaches visitors when you press
          Publish, and every published version is kept, so an earlier one can be brought back.
          {!may.publish && " You can prepare drafts; an owner publishes them."}
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
        {pages && (
          <section className="admin-card" aria-labelledby="website-pages">
            <h3 id="website-pages">Pages</h3>
            <p>
              Every page of the website, from the home page to the policies, and new ones you make: blocks of headings,
              text, pictures, galleries, videos, buttons, columns and the studio&rsquo;s own data, arranged by dragging.
            </p>
            <p className="website-state">
              {pages.all === 0 ? (
                "None made yet."
              ) : (
                <>
                  {count(pages.all, "page")}
                  {pages.waiting > 0 && (
                    <>
                      , <strong>{pages.waiting} with changes visitors do not see yet</strong>
                    </>
                  )}
                  .
                </>
              )}
            </p>
            <Link href="/admin/website/pages" className="btn btn-dark btn-small">
              Open the pages
            </Link>
          </section>
        )}
        {design && (
          <section className="admin-card" aria-labelledby="website-design">
            <h3 id="website-design">Design</h3>
            <p>Colours, fonts, the size and weight of headings and text, buttons and spacing, for the whole website.</p>
            <State state={design} />
            <Link href="/admin/website/design" className="btn btn-dark btn-small">
              Edit the design
            </Link>
          </section>
        )}
        {frame && (
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
        )}
        <section className="admin-card" aria-labelledby="website-pictures">
          <h3 id="website-pictures">Pictures</h3>
          <p>The media library: every picture the website can show, each described once. Collections put pictures in sets, with dates if they are seasonal.</p>
          <p className="website-state">
            {count(pictures?.length ?? 0, "picture")}
            {undescribed > 0 && (
              <>
                , <strong>{undescribed} without a description</strong>
              </>
            )}
            . {count(collections?.length ?? 0, "collection")}. A change here shows at once: the library has no drafts.
          </p>
          <Link href="/admin/website/media" className="btn btn-dark btn-small">
            Open the pictures
          </Link>
        </section>
        {fonts && (
          <section className="admin-card" aria-labelledby="website-fonts">
            <h3 id="website-fonts">Your fonts</h3>
            <p>A font of your own, such as a brand font, added as files. The design can then use it like a font of the library.</p>
            <p className="website-state">{fonts.length === 0 ? "None added yet." : `${count(fonts.length, "font")}: ${fonts.map((font) => font.name).join(", ")}.`}</p>
            <Link href="/admin/website/fonts" className="btn btn-dark btn-small">
              Open your fonts
            </Link>
          </section>
        )}
      </div>
    </AdminFrame>
  );
}
