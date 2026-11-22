"use client";

import { useEffect } from "react";
import { recordCustomerViewAction } from "../actions";

/**
 * Writes the access log's line for a customer's page once the page is on screen (question 27). A page that only was
 * prefetched never runs this. Seen again within a few minutes, the server adds no second line (`VIEW_GAP_MINUTES`).
 */
export function RecordView({ email }: { email: string }) {
  useEffect(() => {
    // A line that could not be written is not the viewer's to deal with: the page stays as it is.
    recordCustomerViewAction(email).catch(() => undefined);
  }, [email]);
  return null;
}
