"use client";

import "@puckeditor/core/no-external.css";
import { Puck, type Data } from "@puckeditor/core";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  discardPageDraftAction,
  publishPageAction,
  restorePageVersionAction,
  savePageDraftAction,
} from "@/app/admin/website/pages/actions";
import type { SiteContext } from "@/lib/site/blocks/block";
import type { PageContent } from "@/lib/site/page";
import { WEBSITE_CHECK_PARAM } from "@/lib/site/website-check";
import type { VersionSummary } from "@/server/website";
import { EditorBar, History } from "./parts";
import { checkOnPhones } from "./phone-check";

/** What `restorePageVersion` takes, in place of a version's id, for how the page was built (BUILT_VERSION in src/server/pages.ts). */
const BUILT_VERSION = "built";
import { buildPuckConfig, fromPuckData, SiteProvider, toPuckData, type EditorLists } from "./puck-config";
import { useDraftEditor, type DraftActions, type DraftStart } from "./useDocumentEditor";

/** What the page editor starts from. Made on the server (src/app/admin/website/pages/[id]/page.tsx). */
export interface PageEditorStart extends DraftStart<PageContent> {
  id: string;
  title: string;
  /** The page's address: "/gift-cards". */
  path: string;
  /** True while the page is on the website. A page that never was has nothing to discard. */
  isLive: boolean;
  /** The pictures and collections its blocks can show. */
  site: SiteContext;
  /** True for a page the website was built with: its history can start again from how it was built. */
  builtIn: boolean;
}

export interface PageEditorProps extends EditorLists {
  initial: PageEditorStart;
  versions: VersionSummary[];
  /** The classes that give the site's fonts their names, for the page drawn in the editor's frame. */
  fontClasses: string;
}

/** The screens a page can be drawn at. The widths are the ones the phone tests measure. */
const VIEWPORTS = [
  { width: 1280, label: "Computer", icon: "Monitor" as const },
  { width: 768, label: "Tablet", icon: "Tablet" as const },
  { width: 390, label: "Phone", icon: "Smartphone" as const },
  { width: 320, label: "Small phone", icon: "Smartphone" as const },
];

/**
 * The page editor: Puck, with the site's blocks, and the site's own bar above
 * it. A change is saved as the page's draft by itself; nothing reaches
 * visitors until Publish. Puck reads a page only when it opens, so after a
 * publish, a discard or a version brought back the editor opens again on what
 * is stored (the `key`).
 */
export default function PageEditor(props: PageEditorProps) {
  const [notice, setNotice] = useState("");
  return <PageEditorBody key={props.initial.revision} {...props} notice={notice} report={setNotice} />;
}

/** The page's own document in Puck's frame gets the site's fonts, as every page of the website does. */
function FrameFonts({ frameDocument, fontClasses, children }: { frameDocument?: Document; fontClasses: string; children: ReactNode }) {
  useEffect(() => {
    frameDocument?.documentElement.setAttribute("class", fontClasses);
  }, [frameDocument, fontClasses]);
  return <>{children}</>;
}

function PageEditorBody({ initial, versions, collections, links, fontClasses, notice, report }: PageEditorProps & { notice: string; report: (notice: string) => void }) {
  const actions = useMemo<DraftActions<PageContent>>(
    () => ({
      save: (content, basedOn, force) => savePageDraftAction(initial.id, content, basedOn, force),
      publish: (basedOn) => publishPageAction(initial.id, basedOn),
      discard: () => discardPageDraftAction(initial.id),
      restore: (versionId) => restorePageVersionAction(initial.id, versionId),
      // Requirement 24's guard rails: the draft, as visitors would get it, measured at phone widths before it is published.
      check: {
        busy: "Checking the page at the width of a phone…",
        subject: "this page",
        // Drawn with the design and the header, menu and footer as published, whatever drafts of them are waiting.
        run: async () => ({ problems: await checkOnPhones(`/admin/website/pages/${encodeURIComponent(initial.id)}/check?${WEBSITE_CHECK_PARAM}=page`) }),
      },
    }),
    [initial.id],
  );
  const editor = useDraftEditor(initial, actions, report);
  const config = useMemo(() => buildPuckConfig({ collections, links }), [collections, links]);
  const [data] = useState<Data>(() => toPuckData(initial.content));
  const overrides = useMemo(
    () => ({
      // The site's own bar has the buttons that save, show and publish: Puck's own are not used.
      headerActions: () => <></>,
      iframe: ({ children, document }: { children: ReactNode; document?: Document }) => (
        <FrameFonts frameDocument={document} fontClasses={fontClasses}>
          {children}
        </FrameFonts>
      ),
    }),
    [fontClasses],
  );

  return (
    <SiteProvider initial={initial.site}>
      <div className="site-editor page-editor">
        <EditorBar editor={editor} notice={notice} previewPath={initial.path} canDiscard={initial.isLive} />
        <p className="page-editor-narrow editor-hint">The page editor is made for a computer or a tablet. On a phone it works, but there is little room.</p>
        <div className="page-editor-canvas" inert={editor.busy}>
          <Puck
            config={config}
            data={data}
            onChange={(next) => editor.change(fromPuckData(next))}
            viewports={VIEWPORTS}
            headerTitle={initial.title}
            headerPath={initial.path}
            height="max(560px, calc(100dvh - 72px - 9rem))"
            overrides={overrides}
          />
        </div>
        <History
          editor={editor}
          versions={versions}
          onOriginal={initial.builtIn ? () => void editor.restore(BUILT_VERSION) : undefined}
          originalLabel="Start again from the page as it was built"
        />
      </div>
    </SiteProvider>
  );
}
