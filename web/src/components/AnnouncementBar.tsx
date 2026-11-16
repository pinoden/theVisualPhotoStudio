"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { isInternalHref, type SiteFrame } from "@/lib/site/frame";

const KEY = "announcement-closed";
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The text of the announcement this visitor closed, for as long as the tab stays open. */
function closedText(): string {
  try {
    return window.sessionStorage.getItem(KEY) ?? "";
  } catch {
    return ""; // storage switched off in the browser: the bar simply cannot be closed for good
  }
}

/** Where the bar is left out: the pages for people who work at the studio. */
const WITHOUT_BAR = /^\/(admin|staff|dev)(\/|$)/;

/**
 * The announcement bar under the header: one message, with an optional link,
 * that the owners switch on under Admin, Website. A visitor can close it; it
 * stays closed until they close the tab, and comes back when the message
 * changes.
 */
export function AnnouncementBar({ announcement }: { announcement: SiteFrame["announcement"] }) {
  const pathname = usePathname();
  const closed = useSyncExternalStore(subscribe, closedText, () => "");
  if (closed === announcement.text || WITHOUT_BAR.test(pathname)) return null;

  const close = () => {
    try {
      window.sessionStorage.setItem(KEY, announcement.text);
    } catch {
      // nothing to remember it in
    }
    for (const listener of listeners) listener();
  };

  return (
    <div className={`site-announcement is-${announcement.style}`} role="region" aria-label="Announcement">
      <div className="announcement-content">
        {announcement.text}
        {announcement.linkHref && (
          <>
            {" "}
            {isInternalHref(announcement.linkHref) ? (
              <Link href={announcement.linkHref}>{announcement.linkLabel}</Link>
            ) : (
              <a href={announcement.linkHref}>{announcement.linkLabel}</a>
            )}
          </>
        )}
      </div>
      <button type="button" className="announcement-close" aria-label="Close this announcement" onClick={close}>
        ×
      </button>
    </div>
  );
}
