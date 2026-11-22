import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Db, DbLike } from "@/db/client";
import { bookings, customerViews, emailChanges, loyaltyLedger, memberships, promoCodes, users } from "@/db/schema";
import { studioToday } from "@/lib/domain/time";
import { normalizeEmail, type AuthUser } from "./auth";
import { emailChangeCodeEmail, emailChangedEmail, queueEmail } from "./email";

/**
 * A client changes the email address their records are kept under (question 27, answered 2026-11-18). The site keeps
 * a client's bookings, codes, stamps and membership by their address, so the change moves every one of them, and it
 * is made only once a code sent to the new address is given back: the client shows the new inbox is theirs, as at
 * sign-in. The old address is told. What the builder read into the answer is question 58 in ProjectLibrary.md.
 */

const CODE_MINUTES = 10;
const MAX_TRIES = 5;
const MAX_PER_WINDOW = 3;
const WINDOW_MINUTES = 15;
const MAX_PER_DAY = 10;

export type ChangeRefusal =
  /** Not an email address. */
  | "invalid_email"
  /** The address the account has already. */
  | "same"
  /** Records are kept under the new address already: joining two addresses is the studio's to do. */
  | "in_use"
  /** A member of the studio: their address is set by the owners (staff) or by the host's settings (owners). */
  | "not_customer"
  /** A membership still billed by the card processor under the old address. */
  | "member"
  | "too_many";

export type RequestChangeResult = { ok: true; email: string } | { ok: false; code: ChangeRefusal };
export type ConfirmChangeResult = { ok: true; email: string } | { ok: false; code: "invalid" | "too_many_tries" | "in_use" | "member" | "not_customer" };

const hashOf = (userId: string, email: string, code: string) => createHash("sha256").update(`change:${userId}:${email}:${code}`).digest("hex");

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/**
 * Whether anything of a client is kept under `email`: an account that holds more than an empty sign-in, a booking, a
 * code, a correction of loyalty, a membership. `exceptUserId` is the account asking, which may hold its own address.
 */
async function holdsRecords(db: DbLike, email: string, exceptUserId: string): Promise<boolean> {
  const checks = await Promise.all([
    db.select({ id: bookings.id }).from(bookings).where(eq(bookings.customerEmail, email)).limit(1),
    db.select({ id: promoCodes.id }).from(promoCodes).where(eq(promoCodes.email, email)).limit(1),
    db.select({ id: loyaltyLedger.id }).from(loyaltyLedger).where(eq(loyaltyLedger.email, email)).limit(1),
    db.select({ id: memberships.id }).from(memberships).where(eq(memberships.email, email)).limit(1),
    db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, email), ne(users.id, exceptUserId), or(ne(users.role, "customer"), ne(users.name, ""), ne(users.phone, ""))))
      .limit(1),
  ]);
  return checks.some((rows) => rows.length > 0);
}

/** A membership the processor still bills, or one paid for until a day still to come, under `email`. */
async function hasRunningMembership(db: DbLike, email: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.email, email),
        or(inArray(memberships.status, ["starting", "active"]), and(eq(memberships.status, "cancelled"), gte(memberships.endsOn, studioToday(now)))),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** The name to greet the client by: their account's, or the one they gave with their latest booking. */
async function nameOf(db: DbLike, user: AuthUser): Promise<string> {
  if (user.name) return user.name;
  const [latest] = await db.select({ name: bookings.customerName }).from(bookings).where(eq(bookings.customerEmail, user.email)).orderBy(desc(bookings.createdAt)).limit(1);
  return latest?.name || "there";
}

/** Email a code to the new address. Nothing changes until it is given back (`confirmEmailChange`). */
export async function requestEmailChange(db: DbLike, user: AuthUser, rawEmail: unknown, now: Date): Promise<RequestChangeResult> {
  if (user.role !== "customer") return { ok: false, code: "not_customer" };
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, code: "invalid_email" };
  if (email === user.email) return { ok: false, code: "same" };
  if (await hasRunningMembership(db, user.email, now)) return { ok: false, code: "member" };
  if (await holdsRecords(db, email, user.id)) return { ok: false, code: "in_use" };

  const asked = async (since: Date) =>
    (
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(emailChanges)
        .where(and(eq(emailChanges.userId, user.id), gt(emailChanges.createdAt, since)))
    )[0].n;
  if ((await asked(new Date(now.getTime() - WINDOW_MINUTES * 60_000))) >= MAX_PER_WINDOW) return { ok: false, code: "too_many" };
  if ((await asked(new Date(now.getTime() - 86_400_000))) >= MAX_PER_DAY) return { ok: false, code: "too_many" };

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(now.getTime() + CODE_MINUTES * 60_000);
  await db.insert(emailChanges).values({ userId: user.id, oldEmail: user.email, newEmail: email, codeHash: hashOf(user.id, email, code), expiresAt, createdAt: now });
  // A code not sent within its minutes is not sent later, as a sign-in code.
  await queueEmail(db, { ...emailChangeCodeEmail({ to: email, name: await nameOf(db, user), code, minutes: CODE_MINUTES }), expiresAt });
  return { ok: true, email };
}

/** The address a code is waiting for, if one is: the newest request that is neither used nor out of time. */
export async function pendingEmailChange(db: DbLike, user: AuthUser, now: Date): Promise<string | null> {
  const [row] = await db
    .select({ newEmail: emailChanges.newEmail })
    .from(emailChanges)
    .where(and(eq(emailChanges.userId, user.id), isNull(emailChanges.consumedAt), gt(emailChanges.expiresAt, now)))
    .orderBy(desc(emailChanges.createdAt))
    .limit(1);
  return row?.newEmail ?? null;
}

/**
 * Check the code and move everything kept under the old address to the new one, in one transaction: the account, the
 * bookings, the codes, loyalty's corrections, the memberships and the access log of the customer's page. The copies of
 * emails already sent, and sign-in codes, stay as they were sent. An empty account the new address had (signed in once,
 * nothing kept) gives way to this one.
 */
export async function confirmEmailChange(db: Db, user: AuthUser, rawCode: unknown, now: Date): Promise<ConfirmChangeResult> {
  if (user.role !== "customer") return { ok: false, code: "not_customer" };
  const code = typeof rawCode === "string" ? rawCode.replace(/\s+/g, "") : "";
  if (!/^\d{6}$/.test(code)) return { ok: false, code: "invalid" };
  const [row] = await db
    .select()
    .from(emailChanges)
    .where(and(eq(emailChanges.userId, user.id), isNull(emailChanges.consumedAt), gt(emailChanges.expiresAt, now)))
    .orderBy(desc(emailChanges.createdAt))
    .limit(1);
  if (!row || row.oldEmail !== user.email) return { ok: false, code: "invalid" };

  // Each try is counted before the code is compared, as at sign-in.
  const [tried] = await db
    .update(emailChanges)
    .set({ attempts: sql`${emailChanges.attempts} + 1` })
    .where(and(eq(emailChanges.id, row.id), lt(emailChanges.attempts, MAX_TRIES), isNull(emailChanges.consumedAt)))
    .returning({ attempts: emailChanges.attempts });
  if (!tried) return { ok: false, code: "too_many_tries" };
  if (!sameHex(row.codeHash, hashOf(user.id, row.newEmail, code))) {
    return { ok: false, code: tried.attempts >= MAX_TRIES ? "too_many_tries" : "invalid" };
  }

  const from = row.oldEmail;
  const to = row.newEmail;
  return db.transaction(async (tx): Promise<ConfirmChangeResult> => {
    // The account is locked, so a second confirmation waits here and then finds the code used.
    await tx.execute(sql`select id from users where id = ${user.id} for update`);
    const consumed = await tx
      .update(emailChanges)
      .set({ consumedAt: now })
      .where(and(eq(emailChanges.id, row.id), isNull(emailChanges.consumedAt)))
      .returning({ id: emailChanges.id });
    if (consumed.length === 0) return { ok: false, code: "invalid" };
    // Looked at again: a booking may have been made under the new address since the code was sent.
    if (await hasRunningMembership(tx, from, now)) return { ok: false, code: "member" };
    if (await holdsRecords(tx, to, user.id)) return { ok: false, code: "in_use" };

    const name = await nameOf(tx, user);
    await tx.delete(users).where(and(eq(users.email, to), ne(users.id, user.id)));
    await tx.update(users).set({ email: to }).where(eq(users.id, user.id));
    await tx.update(bookings).set({ customerEmail: to }).where(eq(bookings.customerEmail, from));
    await tx.update(promoCodes).set({ email: to }).where(eq(promoCodes.email, from));
    await tx.update(loyaltyLedger).set({ email: to }).where(eq(loyaltyLedger.email, from));
    await tx.update(memberships).set({ email: to }).where(eq(memberships.email, from));
    await tx.update(customerViews).set({ customerEmail: to }).where(eq(customerViews.customerEmail, from));
    await queueEmail(tx, emailChangedEmail({ to: from, name, newEmail: to }));
    return { ok: true, email: to };
  });
}

/** The addresses a client's records were kept under before, newest first, with when each change was made. */
export async function earlierAddresses(db: DbLike, email: string): Promise<{ email: string; changedAt: string }[]> {
  const rows = await db
    .select({ oldEmail: emailChanges.oldEmail, consumedAt: emailChanges.consumedAt })
    .from(emailChanges)
    .innerJoin(users, eq(users.id, emailChanges.userId))
    .where(and(eq(users.email, email), sql`${emailChanges.consumedAt} is not null`))
    .orderBy(desc(emailChanges.consumedAt));
  return rows.map((row) => ({ email: row.oldEmail, changedAt: row.consumedAt!.toISOString() }));
}
