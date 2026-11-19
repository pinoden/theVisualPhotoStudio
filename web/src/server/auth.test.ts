import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { loginCodes, sessions, users } from "@/db/schema";
import {
  deleteSession,
  effectiveRole,
  getSessionUser,
  MAX_CODES_PER_DAY,
  normalizeEmail,
  parseOwnerEmails,
  requestLoginCode,
  verifyLoginCode,
} from "./auth";
import { createTestWorld, daysAfter, expectOk, minutesAfter, NOW, type TestWorld } from "./testing";
import { deliverPendingEmails, MAX_EMAIL_ATTEMPTS, OUT_OF_DATE, queueEmail, type EmailTransport } from "./email";
import { emailOutbox } from "@/db/schema";

let world: TestWorld;
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(() => world.reset());

const deps = (now = NOW, ownerEmails: string[] = []) => ({ now, ownerEmails });

/** The code from the most recent sign-in email to an address. */
async function emailedCode(email: string): Promise<string> {
  const mails = (await world.emails("login_code")).filter((m) => m.toEmail === email);
  const match = /code: (\d{6})/.exec(mails.at(-1)!.subject);
  if (!match) throw new Error("no code in email");
  return match[1];
}

/** A six-digit code that is certainly not `code`. */
const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

describe("signing in with an emailed code", () => {
  it("emails a six-digit code, creates the account on first use and opens a session", async () => {
    expect(await requestLoginCode(world.db, "  Jane@Example.com ", NOW)).toEqual({ ok: true, email: "jane@example.com" });
    const [mail] = await world.emails("login_code");
    expect(mail.toEmail).toBe("jane@example.com");
    expect(mail.body).toContain("expires in 10 minutes");

    const code = await emailedCode("jane@example.com");
    const result = expectOk(await verifyLoginCode(world.db, "JANE@example.com", ` ${code} `, deps(minutesAfter(NOW, 1))));
    expect(result.user).toMatchObject({ email: "jane@example.com", role: "customer" });
    expect(result.sessionToken.length).toBeGreaterThan(30);

    expect(await getSessionUser(world.db, result.sessionToken, minutesAfter(NOW, 5))).toMatchObject({ email: "jane@example.com" });
    expect(await getSessionUser(world.db, result.sessionToken, daysAfter(NOW, 31))).toBeNull(); // sessions last 30 days
    expect(await getSessionUser(world.db, "x".repeat(43), NOW)).toBeNull();
    expect(await getSessionUser(world.db, undefined, NOW)).toBeNull();
  });

  it("stores only hashes of the code and of the session token", async () => {
    await requestLoginCode(world.db, "jane@example.com", NOW);
    const code = await emailedCode("jane@example.com");
    const result = expectOk(await verifyLoginCode(world.db, "jane@example.com", code, deps()));
    const [codeRow] = await world.db.select().from(loginCodes);
    const [sessionRow] = await world.db.select().from(sessions);
    expect(JSON.stringify(codeRow)).not.toContain(code);
    expect(JSON.stringify(sessionRow)).not.toContain(result.sessionToken);
  });

  it("accepts a code once", async () => {
    await requestLoginCode(world.db, "jane@example.com", NOW);
    const code = await emailedCode("jane@example.com");
    expect((await verifyLoginCode(world.db, "jane@example.com", code, deps())).ok).toBe(true);
    expect(await verifyLoginCode(world.db, "jane@example.com", code, deps())).toEqual({ ok: false, code: "invalid" });
  });

  it("lets only one of two simultaneous uses of a code succeed", async () => {
    await requestLoginCode(world.db, "jane@example.com", NOW);
    const code = await emailedCode("jane@example.com");
    const results = await Promise.all([
      verifyLoginCode(world.db, "jane@example.com", code, deps()),
      verifyLoginCode(world.db, "jane@example.com", code, deps()),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await world.db.select().from(sessions)).toHaveLength(1);
  });

  it("expires a code after ten minutes", async () => {
    await requestLoginCode(world.db, "jane@example.com", NOW);
    const code = await emailedCode("jane@example.com");
    expect(await verifyLoginCode(world.db, "jane@example.com", code, deps(minutesAfter(NOW, 11)))).toEqual({ ok: false, code: "invalid" });
    expect((await verifyLoginCode(world.db, "jane@example.com", code, deps(minutesAfter(NOW, 9)))).ok).toBe(true);
  });

  it("locks a code after five wrong guesses, even for the right code", async () => {
    await requestLoginCode(world.db, "jane@example.com", NOW);
    const code = await emailedCode("jane@example.com");
    for (let i = 0; i < 4; i++) {
      expect(await verifyLoginCode(world.db, "jane@example.com", wrong(code), deps())).toEqual({ ok: false, code: "invalid" });
    }
    expect(await verifyLoginCode(world.db, "jane@example.com", wrong(code), deps())).toEqual({ ok: false, code: "too_many_attempts" });
    expect(await verifyLoginCode(world.db, "jane@example.com", code, deps())).toEqual({ ok: false, code: "too_many_attempts" });
    expect(await world.db.select().from(sessions)).toHaveLength(0);
  });

  it("counts every guess before comparing it, so guesses sent at the same moment cannot get past five (security review, 2026-11-19)", async () => {
    await requestLoginCode(world.db, "jane@example.com", NOW);
    const code = await emailedCode("jane@example.com");
    const results = await Promise.all(Array.from({ length: 20 }, () => verifyLoginCode(world.db, "jane@example.com", wrong(code), deps())));
    expect(results.filter((result) => !result.ok && result.code === "invalid")).toHaveLength(4);
    const [row] = await world.db.select({ attempts: loginCodes.attempts }).from(loginCodes);
    expect(row.attempts).toBe(5);
    expect(await verifyLoginCode(world.db, "jane@example.com", code, deps())).toEqual({ ok: false, code: "too_many_attempts" });
  });

  it("sends one address ten codes a day at most, whatever the quarter of an hour", async () => {
    for (let i = 0; i < MAX_CODES_PER_DAY; i++) expect((await requestLoginCode(world.db, "jane@example.com", minutesAfter(NOW, i * 16))).ok).toBe(true);
    expect(await requestLoginCode(world.db, "jane@example.com", minutesAfter(NOW, MAX_CODES_PER_DAY * 16))).toEqual({ ok: false, code: "too_many" });
    expect((await requestLoginCode(world.db, "jane@example.com", minutesAfter(NOW, 24 * 60 + 1))).ok).toBe(true);
  });

  it("does not accept a code sent to a different address", async () => {
    await requestLoginCode(world.db, "jane@example.com", NOW);
    await requestLoginCode(world.db, "eve@example.com", NOW);
    const janesCode = await emailedCode("jane@example.com");
    const evesCode = await emailedCode("eve@example.com");
    if (janesCode !== evesCode) {
      expect(await verifyLoginCode(world.db, "jane@example.com", evesCode, deps())).toEqual({ ok: false, code: "invalid" });
    }
    expect(await world.db.select().from(users)).toHaveLength(0);
  });

  it("limits how many codes an address can request", async () => {
    for (let i = 0; i < 3; i++) expect((await requestLoginCode(world.db, "jane@example.com", minutesAfter(NOW, i))).ok).toBe(true);
    expect(await requestLoginCode(world.db, "jane@example.com", minutesAfter(NOW, 3))).toEqual({ ok: false, code: "too_many" });
    expect((await requestLoginCode(world.db, "other@example.com", minutesAfter(NOW, 3))).ok).toBe(true);
    expect((await requestLoginCode(world.db, "jane@example.com", minutesAfter(NOW, 16))).ok).toBe(true);
  });

  it("refuses malformed addresses and codes", async () => {
    for (const bad of ["", "jane", "jane@", "@example.com", "jane@example", "a b@example.com", 42, null]) {
      expect(await requestLoginCode(world.db, bad, NOW)).toEqual({ ok: false, code: "invalid_email" });
    }
    await requestLoginCode(world.db, "jane@example.com", NOW);
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34", null, 123456]) {
      expect(await verifyLoginCode(world.db, "jane@example.com", bad, deps())).toEqual({ ok: false, code: "invalid" });
    }
    expect(await world.emails("login_code")).toHaveLength(1);
  });

  it("ends a session on sign-out", async () => {
    await requestLoginCode(world.db, "jane@example.com", NOW);
    const result = expectOk(await verifyLoginCode(world.db, "jane@example.com", await emailedCode("jane@example.com"), deps()));
    await deleteSession(world.db, result.sessionToken);
    expect(await getSessionUser(world.db, result.sessionToken, NOW)).toBeNull();
  });
});

describe("a sign-in code's email", () => {
  it("is not sent once its code no longer works, when mail waited for an email service; the rest still is", async () => {
    // No email service yet, as on a host set up before one: a code and a confirmation wait.
    expect(await requestLoginCode(world.db, "late@example.com", NOW)).toMatchObject({ ok: true });
    await queueEmail(world.db, { to: "late@example.com", kind: "booking_confirmation", subject: "Booking confirmed: VS-AAAAAA", body: "Body" });
    const sent: string[] = [];
    const transport: EmailTransport = {
      name: "test",
      async send(mail) {
        sent.push(mail.subject);
        return { ok: true };
      },
    };
    // Three weeks later an email service is set up: the confirmation goes, the code, long out of date, does not.
    expect(await deliverPendingEmails(world.db, transport, daysAfter(NOW, 21))).toEqual({ sent: 1, failed: 0 });
    expect(sent).toEqual(["Booking confirmed: VS-AAAAAA"]);
    expect((await world.db.select().from(emailOutbox).where(eq(emailOutbox.kind, "login_code")))[0]).toMatchObject({
      sentAt: null,
      attempts: MAX_EMAIL_ATTEMPTS,
      error: OUT_OF_DATE,
    });
    // Nothing is tried again.
    expect(await deliverPendingEmails(world.db, transport, daysAfter(NOW, 22))).toEqual({ sent: 0, failed: 0 });
    // A code sent within its minutes goes, as always.
    expect(await requestLoginCode(world.db, "soon@example.com", NOW)).toMatchObject({ ok: true });
    expect(await deliverPendingEmails(world.db, transport, minutesAfter(NOW, 9))).toEqual({ sent: 1, failed: 0 });
    expect(sent.at(-1)).toContain("Your sign-in code");
  });
});

describe("roles", () => {
  async function signIn(email: string, ownerEmails: string[]) {
    await requestLoginCode(world.db, email, NOW);
    return expectOk(await verifyLoginCode(world.db, email, await emailedCode(email), deps(NOW, ownerEmails)));
  }

  it("makes an address on the owner list an owner, and only while it is on the list", async () => {
    const owners = ["Boss@Studio.test"];
    const session = await signIn("boss@studio.test", owners);
    expect(session.user.role).toBe("owner");
    expect((await getSessionUser(world.db, session.sessionToken, NOW, owners))?.role).toBe("owner");
    // Removed from the list: the same session is an ordinary customer at once.
    expect((await getSessionUser(world.db, session.sessionToken, NOW, []))?.role).toBe("customer");
  });

  it("never makes anyone else an owner", async () => {
    expect((await signIn("jane@example.com", ["boss@studio.test"])).user.role).toBe("customer");
    // Even a row tampered to say "owner" does not count without the list.
    await world.db.update(users).set({ role: "owner" }).where(eq(users.email, "jane@example.com"));
    const session = await signIn("jane@example.com", ["boss@studio.test"]);
    expect(session.user.role).toBe("customer");
    expect(effectiveRole("jane@example.com", "owner", [])).toBe("customer");
  });

  it("keeps a staff member's role when they sign in", async () => {
    await world.addUser("sam@studio.test", "staff", "Sam");
    const session = await signIn("sam@studio.test", ["boss@studio.test"]);
    expect(session.user).toMatchObject({ role: "staff", name: "Sam" });
    expect(await world.db.select().from(users)).toHaveLength(1);
  });

  it("parses the owner list from configuration", () => {
    expect(parseOwnerEmails(" Boss@Studio.test, second@studio.test ,, ")).toEqual(["boss@studio.test", "second@studio.test"]);
    expect(parseOwnerEmails(undefined)).toEqual([]);
    expect(normalizeEmail("  A@B.co ")).toBe("a@b.co");
  });
});
