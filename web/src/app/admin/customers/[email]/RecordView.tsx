"use client";

import { useEffect } from "react";

/**
 * Writes the access log's line for a customer's page once the page is on screen (question 27). A page that was only
 * prefetched never runs this. It goes as the browser's beacon, which the next page does not cut off: a fetch or a
 * server action still on its way when the page is left is reported by WebKit as an error of the page. Seen again
 * within a few minutes, the server adds no second line (`VIEW_GAP_MINUTES`).
 */
export function RecordView({ email }: { email: string }) {
  useEffect(() => {
    const address = `/admin/customers/${encodeURIComponent(email)}/viewed`;
    if (!navigator.sendBeacon?.(address)) {
      fetch(address, { method: "POST", keepalive: true, credentials: "same-origin" }).catch(() => undefined);
    }
  }, [email]);
  return null;
}
