import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bookings, customerViews, loyaltyLedger, membershipPlans, memberships, promoCodes, users } from "@/db/schema";
import type { AuthUser } from "./auth";
import { recordCustomerView } from "./customer-views";
import { confirmEmailChange, earlierAddresses, pendingEmailChange, requestEmailChange } from "./email-change";
import { createTestWorld, daysAfter, expectOk, minutesAfter, NOW, type TestWorld } from "./testing";

describe("a client changes their own email address (question 27)", () => {
  let world: TestWorld;
  beforeAll(async () => {
    world = await createTestWorld();
  });
  afterAll(() => world.close());
  beforeEach(() => world.reset());

  const JANE = "jane@example.com";
  const NEW = "jane.smith@example.net";
  const owner: AuthUser = { id: "00000000-0000-4000-8000-000000000001", email: "owner@studio.test", name: "Olga", role: "owner" };

  /** Jane's account, with a booking, a code of her own, a correction of her stamps and a line of the access log. */
  async function jane(): Promise<AuthUser> {
    const user = await world.addUser(JANE, "customer");
    const booked = expectOk(await world.book());
    await world.db.insert(promoCodes).values({ code: "JANE-CREDIT", kind: "amount", value: 2000, issuedCents: 2000, email: JANE });
    await world.db.insert(loyaltyLedger).values({ email: JANE, kind: "stamps", stamps: 2, reason: "Old visits", actor: owner.email });
    await recordCustomerView(world.db, owner, JANE, "page", "", NOW);
    expect(booked.ref).toBeTruthy();
    return user;
  }

  /** The code in the newest email sent to change an address. */
  const codeSent = async () => (await world.emails("email_change_code")).at(-1)!.body.match(/\b(\d{6})\b/)![1];

  it("moves every record to the new address once the code sent there is given back, and tells the old address", async () => {
    const user = await jane();
    expect(await requestEmailChange(world.db, user, " Jane.Smith@Example.NET ", NOW)).toEqual({ ok: true, email: NEW });
    const [mail] = await world.emails("email_change_code");
    expect(mail.toEmail).toBe(NEW);
    expect(mail.subject).toMatch(/^Confirm your new email address: \d{6}$/);
    expect(mail.body).toContain("Hi Jane Smith,"); // her name from her booking, as the account has none
    expect(await pendingEmailChange(world.db, user, minutesAfter(NOW, 5))).toBe(NEW);
    // Nothing has moved yet.
    expect((await world.db.select().from(bookings).where(eq(bookings.customerEmail, JANE))).length).toBe(1);

    const wrong = (await codeSent()) === "000000" ? "111111" : "000000";
    expect(await confirmEmailChange(world.db, user, wrong, minutesAfter(NOW, 1))).toEqual({ ok: false, code: "invalid" });
    expect(await confirmEmailChange(world.db, user, ` ${await codeSent()} `, minutesAfter(NOW, 2))).toEqual({ ok: true, email: NEW });

    const [account] = await world.db.select().from(users).where(eq(users.id, user.id));
    expect(account.email).toBe(NEW);
    expect((await world.db.select().from(bookings)).map((row) => row.customerEmail)).toEqual([NEW]);
    expect((await world.db.select().from(promoCodes).where(eq(promoCodes.code, "JANE-CREDIT")))[0].email).toBe(NEW);
    expect((await world.db.select().from(loyaltyLedger))[0].email).toBe(NEW);
    expect((await world.db.select().from(customerViews))[0].customerEmail).toBe(NEW);
    const [told] = await world.emails("email_changed");
    expect(told.toEmail).toBe(JANE);
    expect(told.body).toContain(`was changed from ${JANE} to ${NEW}`);
    expect(await earlierAddresses(world.db, NEW)).toEqual([{ email: JANE, changedAt: minutesAfter(NOW, 2).toISOString() }]);
    expect(await pendingEmailChange(world.db, { ...user, email: NEW }, minutesAfter(NOW, 3))).toBeNull();
    // The code works once.
    expect(await confirmEmailChange(world.db, { ...user, email: NEW }, await codeSent(), minutesAfter(NOW, 3))).toEqual({ ok: false, code: "invalid" });
  });

  it("refuses an address that holds records, a running membership, the studio's team, and a code out of time or guessed", async () => {
    const user = await jane();
    expect(await requestEmailChange(world.db, user, JANE, NOW)).toEqual({ ok: false, code: "same" });
    expect(await requestEmailChange(world.db, user, "not an address", NOW)).toEqual({ ok: false, code: "invalid_email" });
    expect(await requestEmailChange(world.db, { ...user, role: "manager" }, NEW, NOW)).toEqual({ ok: false, code: "not_customer" });
    expectOk(await world.book({ customer: { name: "Bob Brown", email: "bob@example.com", phone: "407-555-0101" }, startMinute: 14 * 60 }));
    expect(await requestEmailChange(world.db, user, "BOB@example.com", NOW)).toEqual({ ok: false, code: "in_use" });

    // An empty account the new address signed in to once gives way.
    await world.addUser(NEW, "customer");
    expect((await requestEmailChange(world.db, user, NEW, NOW)).ok).toBe(true);
    // Five wrong tries end the code; after its ten minutes, the right one does not work either.
    for (let i = 0; i < 4; i++) expect((await confirmEmailChange(world.db, user, "999999", NOW)).ok).toBe(false);
    expect(await confirmEmailChange(world.db, user, "999998", NOW)).toEqual({ ok: false, code: "too_many_tries" });
    expect(await confirmEmailChange(world.db, user, await codeSent(), NOW)).toEqual({ ok: false, code: "too_many_tries" });
    expect((await requestEmailChange(world.db, user, NEW, minutesAfter(NOW, 1))).ok).toBe(true);
    expect(await confirmEmailChange(world.db, user, await codeSent(), minutesAfter(NOW, 12))).toEqual({ ok: false, code: "invalid" });
    // Three codes in 15 minutes at most.
    expect((await requestEmailChange(world.db, user, NEW, minutesAfter(NOW, 2))).ok).toBe(true);
    expect(await requestEmailChange(world.db, user, NEW, minutesAfter(NOW, 3))).toEqual({ ok: false, code: "too_many" });
    expect(await confirmEmailChange(world.db, user, await codeSent(), minutesAfter(NOW, 4))).toEqual({ ok: true, email: NEW });
    expect((await world.db.select().from(users).where(eq(users.email, NEW))).map((row) => row.id)).toEqual([user.id]);

    // A member waits for the studio: the card processor bills the membership under the address it has.
    const member = { ...user, email: NEW };
    const [plan] = await world.db.insert(membershipPlans).values({ name: "Monthly", minutes: 240, priceCents: 30000 }).returning();
    const [row] = await world.db
      .insert(memberships)
      .values({ email: NEW, name: "Jane Smith", planId: plan.id, planName: plan.name, minutesPerMonth: 240, priceCents: 30000, code: "MEMBER-1", status: "active", requestKey: "k1", provider: "test", startedOn: "2026-11-01" })
      .returning();
    expect(await requestEmailChange(world.db, member, "jane@example.org", daysAfter(NOW, 1))).toEqual({ ok: false, code: "member" });
    await world.db.update(memberships).set({ status: "cancelled", endsOn: "2026-12-01" }).where(eq(memberships.id, row.id));
    expect(await requestEmailChange(world.db, member, "jane@example.org", daysAfter(NOW, 1))).toEqual({ ok: false, code: "member" });
    expect((await requestEmailChange(world.db, member, "jane@example.org", new Date("2026-12-02T15:00:00Z"))).ok).toBe(true);
  });
});
