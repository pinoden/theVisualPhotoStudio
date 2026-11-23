/**
 * A cookie set beside the session (`openSession`), and readable by the page's scripts, only so that the website's menu
 * can say "My Account" in place of "Log In" (the owner's brief of 2026-11-22): the menu is the same page for everyone.
 * It holds no token and lets nothing in; every page still asks the session. It can outlive a session ended elsewhere,
 * and the menu then says "My Account" until the visitor signs in again or the cookie runs out with the session's time.
 */
export const SIGNED_IN_HINT = "vs_signed_in";

/** Whether the cookie says a visitor is signed in: `document.cookie` in the browser. */
export function hintsSignedIn(cookieHeader: string): boolean {
  return cookieHeader.split(";").some((part) => part.trim() === `${SIGNED_IN_HINT}=1`);
}
