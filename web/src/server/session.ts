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
export const SESSION_COOKIE = "vs_session";

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

/** Only same-site paths are followed after sign-in. */
export function safeNextPath(value: unknown): string {
  if (typeof value !== "string") return "/account";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.length > 300) return "/account";
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
export async function requireRole(roles: Role[], next: string): Promise<AuthUser> {
  const user = await requireUser(next);
  if (!roles.includes(user.role)) notFound();
  return user;
}

export const requireOwner = (next: string) => requireRole(["owner"], next);
export const requireStaff = (next: string) => requireRole(["staff", "owner"], next);

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
