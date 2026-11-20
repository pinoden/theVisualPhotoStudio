import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { loginCodes, sessions, users } from "@/db/schema";
import type { Db, DbLike } from "@/db/client";
import { EMAIL_RULE } from "@/lib/parse";
import { loginCodeEmail, queueEmail } from "./email";

/**
 * Sign-in without passwords: the person proves they own an email address by
 * typing a one-time code sent to it. The first sign-in creates the account.
 * Only hashes of codes and session tokens are stored.
 */
export type Role = "customer" | "staff" | "manager" | "owner";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

const CODE_TTL_MINUTES = 10;
const MAX_CODE_ATTEMPTS = 5;
const MAX_CODES_PER_WINDOW = 3;
const CODE_WINDOW_MINUTES = 15;
/** Codes one address may be sent in a day: with five tries each, at most fifty guesses a day at a million codes. */
export const MAX_CODES_PER_DAY = 10;
const SESSION_DAYS = 30;

/** An email address as the site keeps it: trimmed and in small letters, by the rule every email field follows (`EMAIL_RULE`). */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 200 && EMAIL_RULE.test(email) ? email : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function codeHash(email: string, code: string): string {
  return sha256(`${email}:${code}`);
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export type RequestCodeResult = { ok: true; email: string } | { ok: false; code: "invalid_email" | "too_many" };

/** Email a fresh sign-in code. */
export async function requestLoginCode(db: DbLike, rawEmail: unknown, now: Date): Promise<RequestCodeResult> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, code: "invalid_email" };

  const windowStart = new Date(now.getTime() - CODE_WINDOW_MINUTES * 60_000);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(loginCodes)
    .where(and(eq(loginCodes.email, email), gt(loginCodes.createdAt, windowStart)));
  if (count >= MAX_CODES_PER_WINDOW) return { ok: false, code: "too_many" };
  const [{ today }] = await db
    .select({ today: sql<number>`count(*)::int` })
    .from(loginCodes)
    .where(and(eq(loginCodes.email, email), gt(loginCodes.createdAt, new Date(now.getTime() - 86_400_000))));
  if (today >= MAX_CODES_PER_DAY) return { ok: false, code: "too_many" };

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(now.getTime() + CODE_TTL_MINUTES * 60_000);
  await db.insert(loginCodes).values({ email, codeHash: codeHash(email, code), expiresAt, createdAt: now });
  // A code that could not be sent in its minutes (no email service set up yet) is not sent later: it no longer works.
  await queueEmail(db, { ...loginCodeEmail(email, code, CODE_TTL_MINUTES), expiresAt });
  return { ok: true, email };
}

export type VerifyCodeResult =
  | { ok: true; user: AuthUser; sessionToken: string; expiresAt: Date }
  | { ok: false; code: "invalid" | "too_many_attempts" };

export interface VerifyDeps {
  now: Date;
  /** Addresses that are always given the owner role (from OWNER_EMAILS). */
  ownerEmails: string[];
}

/** Check a sign-in code. On success the account exists and a session is open. */
export async function verifyLoginCode(db: Db, rawEmail: unknown, rawCode: unknown, deps: VerifyDeps): Promise<VerifyCodeResult> {
  const email = normalizeEmail(rawEmail);
  const code = typeof rawCode === "string" ? rawCode.replace(/\s+/g, "") : "";
  if (!email || !/^\d{6}$/.test(code)) return { ok: false, code: "invalid" };
  const { now } = deps;

  // Only the newest unused, unexpired code counts. Asking for a new code
  // therefore cancels the older ones.
  const [row] = await db
    .select()
    .from(loginCodes)
    .where(and(eq(loginCodes.email, email), isNull(loginCodes.consumedAt), gt(loginCodes.expiresAt, now)))
    .orderBy(desc(loginCodes.createdAt))
    .limit(1);
  if (!row) return { ok: false, code: "invalid" };

  // Each try is counted before the code is compared, in one statement that only counts while tries are left: guesses
  // sent at the same moment cannot all read "no tries yet" (the security review of 2026-11-19).
  const [tried] = await db
    .update(loginCodes)
    .set({ attempts: sql`${loginCodes.attempts} + 1` })
    .where(and(eq(loginCodes.id, row.id), lt(loginCodes.attempts, MAX_CODE_ATTEMPTS), isNull(loginCodes.consumedAt)))
    .returning({ attempts: loginCodes.attempts });
  if (!tried) return { ok: false, code: "too_many_attempts" };

  if (!safeEqualHex(row.codeHash, codeHash(email, code))) {
    return { ok: false, code: tried.attempts >= MAX_CODE_ATTEMPTS ? "too_many_attempts" : "invalid" };
  }

  // Consume the code; if another request used it in the meantime, refuse.
  const consumed = await db
    .update(loginCodes)
    .set({ consumedAt: now })
    .where(and(eq(loginCodes.id, row.id), isNull(loginCodes.consumedAt)))
    .returning({ id: loginCodes.id });
  if (consumed.length === 0) return { ok: false, code: "invalid" };

  const isOwner = isOwnerEmail(email, deps.ownerEmails);
  const [user] = await db
    .insert(users)
    .values({ email, role: isOwner ? "owner" : "customer" })
    // Signing in never changes a stored role; the no-op update only returns the row.
    .onConflictDoUpdate({ target: users.email, set: { email } })
    .returning();

  const sessionToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  await db.insert(sessions).values({ userId: user.id, tokenHash: sha256(sessionToken), expiresAt });

  return {
    ok: true,
    user: { id: user.id, email: user.email, name: user.name, role: effectiveRole(user.email, user.role, deps.ownerEmails) },
    sessionToken,
    expiresAt,
  };
}

function isOwnerEmail(email: string, ownerEmails: string[]): boolean {
  return ownerEmails.some((e) => e.trim().toLowerCase() === email);
}

/**
 * The owner list in the configuration (OWNER_EMAILS) is the only thing that
 * makes someone an owner. Adding an address grants it and removing an address
 * revokes it at the next request, whatever the database says.
 */
export function effectiveRole(email: string, storedRole: Role, ownerEmails: string[]): Role {
  if (isOwnerEmail(email, ownerEmails)) return "owner";
  return storedRole === "owner" ? "customer" : storedRole;
}

/** The signed-in user for a session token, or null. */
export async function getSessionUser(
  db: DbLike,
  token: string | undefined,
  now: Date,
  ownerEmails: string[] = [],
): Promise<AuthUser | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const [row] = await db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, now)))
    .limit(1);
  return row ? { ...row, role: effectiveRole(row.email, row.role, ownerEmails) } : null;
}

export async function deleteSession(db: DbLike, token: string | undefined): Promise<void> {
  if (!token) return;
  await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
}

/** Sign a user out everywhere (used when the owner removes a staff member). */
export async function deleteAllSessions(db: DbLike, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export function parseOwnerEmails(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}
