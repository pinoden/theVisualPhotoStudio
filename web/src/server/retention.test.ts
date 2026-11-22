import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { emailOutbox, loginCodes, sessions, users } from "@/db/schema";
import { deleteOldRecords, retentionCutoff } from "./retention";
import { saveSetting } from "./settings";
import { runScheduledTasks } from "./tasks";
import { createTestWorld, daysAfter, NOW, type TestWorld } from "./testing";

describe("records kept for the owners' retention period (the owner's answer of 2026-11-21: 5 years)", () => {
  let world: TestWorld;
  beforeAll(async () => {
    world = await createTestWorld();
  });
  afterAll(() => world.close());
  beforeEach(() => world.reset());

  const yearsBefore = (years: number, days = 0) => daysAfter(retentionCutoff(NOW, years), days);

  /** One email copy, one sign-in code and one sign-in, each dated `at`, for the client `name`. */
  async function recordsOf(name: string, at: Date) {
    const [user] = await world.db.insert(users).values({ email: `${name}@example.test`, name }).returning({ id: users.id });
    await world.db.insert(emailOutbox).values({ toEmail: `${name}@example.test`, subject: `For ${name}`, body: "…", kind: "test", sentAt: at, createdAt: at });
    await world.db.insert(loginCodes).values({ email: `${name}@example.test`, codeHash: `hash-${name}`, expiresAt: new Date(at.getTime() + 600_000), createdAt: at });
    await world.db.insert(sessions).values({ userId: user.id, tokenHash: `token-${name}`, expiresAt: at, createdAt: daysAfter(at, -30) });
  }

  const left = async () => ({
    emails: (await world.db.select({ subject: emailOutbox.subject }).from(emailOutbox)).map((row) => row.subject).sort(),
    codes: (await world.db.select({ hash: loginCodes.codeHash }).from(loginCodes)).map((row) => row.hash).sort(),
    sessions: (await world.db.select({ token: sessions.tokenHash }).from(sessions)).map((row) => row.token).sort(),
  });

  it("deletes what is older than five years and keeps the rest", async () => {
    await recordsOf("old", yearsBefore(5, -1));
    await recordsOf("recent", yearsBefore(5, 1));
    expect(await deleteOldRecords(world.db, NOW, 5)).toEqual({ emails: 1, loginCodes: 1, sessions: 1 });
    expect(await left()).toEqual({ emails: ["For recent"], codes: ["hash-recent"], sessions: ["token-recent"] });
    expect(await deleteOldRecords(world.db, NOW, 5)).toEqual({ emails: 0, loginCodes: 0, sessions: 0 });
  });

  it("counts years by the calendar, a leap day included", () => {
    expect(retentionCutoff(new Date("2026-11-14T15:00:00Z"), 5).toISOString()).toBe("2021-11-14T15:00:00.000Z");
    expect(retentionCutoff(new Date("2028-02-29T12:00:00Z"), 5).toISOString()).toBe("2023-03-01T12:00:00.000Z");
  });

  it("is done by the scheduled task, for the years set under Settings", async () => {
    await recordsOf("six", yearsBefore(6, -1));
    await recordsOf("three", yearsBefore(3, -1));
    const run = () => runScheduledTasks(world.db, { ...world.manageDeps({ now: NOW }), email: null });
    expect((await run()).oldRecordsDeleted).toBe(3);
    expect(await saveSetting(world.db, "retentionYears", 2)).toBe(true);
    expect((await run()).oldRecordsDeleted).toBe(3);
    expect(await left()).toEqual({ emails: [], codes: [], sessions: [] });
    expect(await saveSetting(world.db, "retentionYears", 0)).toBe(false);
  });
});
