"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";

const noChange = () => () => {};

/**
 * Shown at the foot of every page while someone is looking at changes that
 * are not published (see src/server/site.ts), so a preview is never mistaken
 * for the live website. Left out when the page is shown inside the editor,
 * which has its own buttons, and on the admin's own pages.
 */
export function PreviewBar() {
  const pathname = usePathname();
  // Only known in the browser: inside the editor the page is in a frame.
  const topLevel = useSyncExternalStore(
    noChange,
    () => window.self === window.top,
    () => false,
  );
  if (!topLevel || pathname.startsWith("/admin")) return null;
  return (
    <div className="preview-bar no-print" role="status">
      <span>
        <strong>Preview.</strong> This shows changes that are not published yet. Visitors do not see them.
      </span>
      <Link href="/admin/website">Back to the editor</Link>
      <form method="post" action="/admin/website/preview/exit">
        <input type="hidden" name="to" value={pathname} />
        <button type="submit">Leave the preview</button>
      </form>
    </div>
  );
}
