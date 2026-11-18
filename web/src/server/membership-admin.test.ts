import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cancelBooking, getManageChoices, type Actor } from "./manage";
import { correctMinutes, joinMembership, listMembers, listPlans, memberDetail } from "./memberships";
import { MOCK_TOKEN_DECLINED, MOCK_TOKEN_OK } from "./payments";
import { BASE_URL, createTestWorld, expectOk, FAR, NOW, OWNER_EMAIL, type TestWorld } from "./testing";

/** Follow-up 3, step 5 of the plan of 2026-11-18: the owners' members' pages. */
let world: TestWorld;
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(() => world.reset());

const OWNER = { email: OWNER_EMAIL, role: "owner" };
const minutesAfterNow = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

async function join(planName: string, name: string, email: string, token = MOCK_TOKEN_OK, at = NOW) {
  const plan = (await listPlans(world.db)).find((candidate) => candidate.name === planName)!;
  return joinMembership(
    world.db,
    { planId: plan.id, customer: { name, email, phone: "407-555-0100" }, acceptTerms: true, paymentToken: token, requestId: randomUUID() },
    { now: at, payments: world.provider, baseUrl: BASE_URL, ownerEmail: OWNER_EMAIL },
  );
}

describe("the owners' view of memberships", () => {
  it("lists every membership, newest first, with its state and hours left, those never started too", async () => {
    expectOk(await join("Studio Paris, 5 hours a month", "Jane Smith", "jane@example.com"));
    await join("Studio Paris, 5 hours a month", "Bob Brown", "bob@example.com", MOCK_TOKEN_DECLINED, minutesAfterNow(1));
    expectOk(await join("Studio Dayglow, 10 hours a month", "Cara Lee", "cara@example.com", MOCK_TOKEN_OK, minutesAfterNow(2)));
    expect((await listMembers(world.db)).map((member) => [member.name, member.planName, member.status, member.minutesLeft, member.nextBilling])).toEqual([
      ["Cara Lee", "Studio Dayglow, 10 hours a month", "active", 600, "2026-12-14"],
      ["Bob Brown", "Studio Paris, 5 hours a month", "failed", 0, null],
      ["Jane Smith", "Studio Paris, 5 hours a month", "active", 300, "2026-12-14"],
    ]);
  });

  it("shows one membership in full: every change to its minutes, with its booking, and every month paid", async () => {
    const { membership } = expectOk(await join("Studio Paris, 5 hours a month", "Jane Smith", "jane@example.com"));
    const booked = expectOk(await world.book({ studioIds: [world.ids.paris], date: FAR, promoCode: membership.code, paymentToken: undefined }));
    const actor: Actor = { kind: "token", token: booked.manageToken };
    const choices = (await getManageChoices(world.db, booked.ref, actor, NOW))!;
    expectOk(await cancelBooking(world.db, booked.ref, actor, world.manageDeps(), choices.cancel.text));
    expectOk(await correctMinutes(world.db, OWNER, membership.id, { minutes: 90, reason: "  Goodwill   for the broken light " }));

    const detail = (await memberDetail(world.db, membership.id))!;
    expect(detail).toMatchObject({ name: "Jane Smith", phone: "407-555-0100", minutesPerMonth: 300, minutesLeft: 390, status: "active", code: membership.code });
    expect(detail.lines.map((line) => [line.kind, line.minutes, line.bookingRef, line.note, line.actor])).toEqual([
      ["correction", 90, null, "Goodwill for the broken light", OWNER_EMAIL],
      ["returned", 120, booked.ref, `Booking ${booked.ref} cancelled`, "the site"],
      ["booking", -120, booked.ref, `Booking ${booked.ref}`, "the site"],
      ["month", 300, null, "The first month", "the site"],
    ]);
    expect(detail.payments).toEqual([{ periodStart: "2026-11-14", amountCents: 30000, paidAt: NOW, refunded: false }]);
    expect(await memberDetail(world.db, "not-a-membership")).toBeNull();
  });

  it("lets an owner add or take away hours in quarter hours, with a reason, never below nothing", async () => {
    const { membership } = expectOk(await join("Studio Paris, 5 hours a month", "Jane Smith", "jane@example.com"));
    expect(await correctMinutes(world.db, OWNER, membership.id, { minutes: -330, reason: "Too many" })).toEqual({
      ok: false,
      message: "This membership has 5 hours left: no more than that can be taken away.",
    });
    const quarter = "Enter the hours to add or take away in quarter hours, from 0.25 to 100, for example 1.5, or -2 to take two away.";
    for (const minutes of [0, 10, 6015, Number.NaN]) expect(await correctMinutes(world.db, OWNER, membership.id, { minutes, reason: "Because" })).toEqual({ ok: false, message: quarter });
    expect(await correctMinutes(world.db, OWNER, membership.id, { minutes: 60, reason: "x" })).toMatchObject({ ok: false });
    expect(await correctMinutes(world.db, { email: "m@studio.test", role: "manager" }, membership.id, { minutes: 60, reason: "Because" })).toMatchObject({ ok: false });
    expect(await correctMinutes(world.db, OWNER, membership.id, { minutes: -300, reason: "All of them" })).toEqual({ ok: true, minutesLeft: 0 });
    const failed = await join("Studio Paris, 5 hours a month", "Bob Brown", "bob@example.com", MOCK_TOKEN_DECLINED);
    expect(failed.ok).toBe(false);
    const bob = (await listMembers(world.db)).find((member) => member.name === "Bob Brown")!;
    expect(await correctMinutes(world.db, OWNER, bob.id, { minutes: 60, reason: "Because" })).toEqual({ ok: false, message: "Membership not found." });
  });
});
