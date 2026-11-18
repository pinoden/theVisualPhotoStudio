"use client";

import dynamic from "next/dynamic";
import type { PageEditorProps } from "./PageEditor";

/**
 * The page editor, loaded in the browser only. Puck draws the page in a frame
 * of its own and measures it, which only means something in a browser; and
 * the editor is large, so a page of the admin that does not use it never
 * loads it.
 */
const PageEditor = dynamic(() => import("./PageEditor"), {
  ssr: false,
  loading: () => (
    <div className="page-editor-loading">
      <div className="spinner" /> Opening the editor…
    </div>
  ),
});

export function PageEditorLoader(props: PageEditorProps) {
  return <PageEditor {...props} />;
}
