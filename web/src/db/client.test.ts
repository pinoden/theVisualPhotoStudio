import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryDb, isTransaction, openOnce, readyOrClosed, together, withVerifiedSsl, type DbLike } from "./client";

describe("opening the database", () => {
  it("closes a database that was refused once opened, so that nothing of it stays open", async () => {
    const opened = await createMemoryDb();
    let closed = 0;
    const refused = readyOrClosed({ db: opened.db, close: async () => void closed++ }, async () => {
      throw new Error("refused");
    });
    await expect(refused).rejects.toThrow("refused");
    expect(closed).toBe(1);
    // One made ready stays open.
    await expect(readyOrClosed({ db: opened.db, close: async () => void closed++ }, async () => undefined)).resolves.toBe(opened.db);
    expect(closed).toBe(1);
    await opened.close();
  });

  it("opens once for every caller, and tries a failed opening again only after a while, not at every call", async () => {
    let now = 0;
    let attempts = 0;
    let fail = true;
    const open = openOnce(
      async () => {
        attempts++;
        if (fail) throw new Error("refused");
        return "db";
      },
      10_000,
      () => now,
    );
    await expect(open()).rejects.toThrow("refused");
    // Many calls in the next seconds, as every request makes: the same refusal, without opening again.
    for (let call = 0; call < 20; call++) await expect(open()).rejects.toThrow("refused");
    now = 9_999;
    await expect(open()).rejects.toThrow("refused");
    expect(attempts).toBe(1);
    // Put right meanwhile (the database cleared): the next try after the wait opens it, and it is kept.
    fail = false;
    now = 10_000;
    await expect(open()).resolves.toBe("db");
    now = 1_000_000;
    await expect(open()).resolves.toBe("db");
    expect(attempts).toBe(2);
  });
});

describe("the address of a database server", () => {
  it("spells out the certificate check the driver does anyway, and leaves every other address as it is", () => {
    const base = "postgresql://user:secret@ep-x.us-east-1.aws.neon.tech/neondb";
    expect(withVerifiedSsl(`${base}?sslmode=require&channel_binding=require`)).toBe(`${base}?sslmode=verify-full&channel_binding=require`);
    expect(withVerifiedSsl(`${base}?channel_binding=require&sslmode=prefer`)).toBe(`${base}?channel_binding=require&sslmode=verify-full`);
    expect(withVerifiedSsl(`${base}?sslmode=verify-ca`)).toBe(`${base}?sslmode=verify-full`);
    for (const kept of [base, `${base}?sslmode=disable`, `${base}?sslmode=verify-full`, `${base}?sslmode=required`]) expect(withVerifiedSsl(kept)).toBe(kept);
  });
});

describe("the database scripts", () => {
  it("open the database as it is, without the site's check of test mode: their shell has no card processor set up", () => {
    // `getDb` checks the database against the card processor set up. A shell with only DATABASE_URL has the pretend
    // one, which a database of real bookings refuses: migrating or seeding the live database would end in that refusal.
    for (const script of ["migrate.ts", "seed.ts", "clear-test-mode.ts"]) {
      const code = readFileSync(path.join(process.cwd(), "scripts", script), "utf8");
      expect(code, script).toContain("openPostgres(url)");
      expect(code, script).not.toMatch(/\bgetDb\b(?!`)/);
    }
  });
});

describe("queries that do not depend on each other", () => {
  /** Two queries that note when each starts and ends: whether the second waits for the first. */
  async function overlap(db: DbLike): Promise<boolean> {
    const events: string[] = [];
    const query = (name: string) => async () => {
      events.push(`${name} starts`);
      await new Promise((done) => setTimeout(done, 20));
      events.push(`${name} ends`);
      return name;
    };
    expect(await together(db, [query("a"), query("b")])).toEqual(["a", "b"]);
    return events.indexOf("b starts") < events.indexOf("a ends");
  }

  it("run at once on the database, and one after another on a transaction, which has one connection", async () => {
    const opened = await createMemoryDb();
    try {
      expect(isTransaction(opened.db)).toBe(false);
      expect(await overlap(opened.db)).toBe(true);
      await opened.db.transaction(async (tx) => {
        expect(isTransaction(tx)).toBe(true);
        expect(await overlap(tx)).toBe(false);
      });
    } finally {
      await opened.close();
    }
  });
});
