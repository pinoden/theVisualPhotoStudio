import { useEffect, useRef } from "react";
import { hintsSignedIn } from "@/lib/signed-in-hint";
import type { OwnDetails } from "@/server/own-details";

/**
 * A signed-in client's own name, email address and phone number, handed to `fill` once the page has started, so that
 * the booking screen and the membership's checkout need not ask for them again (the owners' decision of 2026-11-27;
 * the preview test of 2026-11-21, point 9). The pages are the same for everyone, so the screen asks
 * `/api/own-details`, and only when the menu's cookie says someone is signed in: a visitor's page asks nothing.
 * `fill` decides what it takes: a field the client has typed in, or one brought back after a refresh, keeps its text.
 */
export function useOwnDetails(fill: (own: OwnDetails) => void): void {
  const latest = useRef(fill);
  useEffect(() => {
    latest.current = fill;
  });
  useEffect(() => {
    if (!hintsSignedIn(document.cookie)) return;
    let gone = false;
    fetch("/api/own-details", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((answer: { details?: OwnDetails | null } | null) => {
        if (!gone && answer?.details) latest.current(answer.details);
      })
      // Without an answer the fields stay empty, as they were before.
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, []);
}
