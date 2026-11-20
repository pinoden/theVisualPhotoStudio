import { cache } from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { deleteSession, getSessionUser, parseOwnerEmails, type AuthUser, type Role } from "./auth";

/**
 * The signed-in user for the current request. Every page and every server
 * action that shows or changes private data must go through these functions;
 * there is no check in a layout, because layouts do not re-run on navigation.
 */
const SESSION_COOKIE = "vs_session";

export function ownerEmails(): string[] {
  return parseOwnerEmails(process.env.OWNER_EMAILS);
}

/** Read once per render, however many components ask. */
export const getCurrentUser = cache(async (): Promise<AuthUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const db = await getDb();
  return getSessionUser(db, token, new Date(), ownerEmails());
});

/**
 * Only same-site paths are followed after sign-in. Browsers drop tabs and line breaks from an address, so "/\t/evil.example"
 * would be read as another site: no control character, space or backslash is allowed (the security review of
 * 2026-11-19), and the path must stay on this site when read as an address.
 */
export function safeNextPath(value: unknown): string {
  if (typeof value !== "string") return "/account";
  if (!value.startsWith("/") || value.startsWith("//") || /[\u0000-\u0020\u007f\\]/.test(value) || value.length > 300) return "/account";
  try {
    if (new URL(value, "https://site.invalid").host !== "site.invalid") return "/account";
  } catch {
    return "/account";
  }
  return value;
}

/** The signed-in user, or a redirect to sign in and come back to `next`. */
export async function requireUser(next: string): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) redirect(`/account/sign-in?next=${encodeURIComponent(safeNextPath(next))}`);
  return user;
}

/**
 * The signed-in user if they hold one of `roles`. Anyone else gets the
 * ordinary "not found" page, so these areas are not advertised.
 */
async function requireRole(roles: Role[], next: string): Promise<AuthUser> {
  const user = await requireUser(next);
  if (!roles.includes(user.role)) notFound();
  return user;
}

export const requireOwner = (next: string) => requireRole(["owner"], next);
/** Anyone who works in the admin: an attendant, a manager or an owner. The service then says what this one may see. */
export const requireStaff = (next: string) => requireRole(["staff", "manager", "owner"], next);
/** A manager or an owner. For the pages a manager can be given: the page asks `can` which, and answers "not found" otherwise. */
export const requireManager = (next: string) => requireRole(["manager", "owner"], next);

/**
 * True when a request that changes something came from this site's own pages.
 * A form on another site may not post here in a signed-in person's name.
 * Browsers name the sending site in `Origin`; a request without one (an old
 * browser, a script) is let through to the checks that follow.
 */
export function sameSiteRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function openSession(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function closeSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await deleteSession(await getDb(), token);
  store.delete(SESSION_COOKIE);
}
