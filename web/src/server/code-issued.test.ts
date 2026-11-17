import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { addons, bookings, payments, promoCodes } from "@/db/schema";
import { MOCK_TOKEN_DECLINED } from "./payments";
import { createAdminBooking } from "./appointments";
import type { AuthUser } from "./auth";
import { cancelBooking, ownerCancelBooking, ownerRefund, requestRescheduleCode } from "./manage";
import { givePetFeeCredit } from "./pet-fee";
import { issuePromo } from "./promos";
import { recordStudioPayment } from "./studio-payments";
import { BASE_URL, createTestWorld, daysAfter, expectOk, FAR, h, hoursAfter, NOW, type TestWorld } from "./testing";

/**
 * Migration 0024 gives the codes a database already had what each was issued
 * for (`promo_codes.issued_cents`), which the code itself keeps from then on.
 * What it works out must be what the code would have kept: here every code is
 * made through the site, in each state a code can be in, then its figure is
 * taken away and the migration's own statements work it out again.
 */
let world: TestWorld;
let owner: AuthUser;
let petFeeId: string;

beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser("owner@studio.test", "owner", "Olivia");
  petFeeId = (await world.db.select().from(addons).where(eq(addons.slug, "pet-fee")))[0].id;
});

const dana = { name: "Dana Diaz", email: "dana@example.com", phone: "407-555-0133" };
const byToken = (token: string) => ({ kind: "token", token }) as const;

/** The statements of the migration that fill the column in. */
function fillIn(): string[] {
  const file = readFileSync(path.join(process.cwd(), "drizzle", "0024_code_issued_value.sql"), "utf8");
  return file
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.startsWith("UPDATE") || statement.startsWith("--"))
    .filter((statement) => /UPDATE "promo_codes"/.test(statement));
}

/** A pet credit of $40, from a booking with the pet fee paid in cash on `startMinute` of FAR. */
async function petCredit(startMinute: number): Promise<string> {
  const made = expectOk(
    await createAdminBooking(
      world.db,
      owner,
      { studioIds: [world.ids.dayglow], date: FAR, startMinute, durationMinutes: 60, addons: [{ addonId: petFeeId, quantity: 1 }], customer: dana },
      { now: NOW, baseUrl: BASE_URL },
    ),
  );
  expectOk(await recordStudioPayment(world.db, owner, made.ref, { amountCents: 11800, method: "cash", note: "" }, NOW));
  return expectOk(await givePetFeeCredit(world.db, owner, made.ref, { now: NOW, baseUrl: BASE_URL })).code;
}

describe("what a code was issued for, worked out by migration 0024", () => {
  it("is what the code kept itself, in every state a code can be in", async () => {
    // A pet credit spent by a booking that was then released for a reschedule code: the money went on into that code.
    const spentThenMoved = await petCredit(h(9));
    const moved = expectOk(await world.book({ date: FAR, startMinute: h(11), durationMinutes: 60, promoCode: spentThenMoved, customer: dana }));
    expectOk(await requestRescheduleCode(world.db, moved.ref, byToken(moved.manageToken), world.manageDeps()));

    // A reschedule code part-spent by a booking its client cancelled: nothing comes back to a reschedule code then.
    const first = expectOk(await world.book({ date: FAR, startMinute: h(13), durationMinutes: 120 })); // $176 by card
    const partSpent = expectOk(await requestRescheduleCode(world.db, first.ref, byToken(first.manageToken), world.manageDeps())).code;
    const spender = expectOk(await world.book({ date: FAR, startMinute: h(9), durationMinutes: 60, promoCode: partSpent, paymentToken: undefined, studioIds: [world.ids.paris] }));
    expectOk(await cancelBooking(world.db, spender.ref, byToken(spender.manageToken), world.manageDeps()));

    // A pet credit spent by a booking the studio cancelled after its start: the code had done its work.
    const spentThenCancelledLate = await petCredit(h(15));
    const visit = expectOk(await world.book({ date: FAR, startMinute: h(16), durationMinutes: 60, promoCode: spentThenCancelledLate, customer: dana, studioIds: [world.ids.paris] }));
    const started = (await world.db.select().from(bookings).where(eq(bookings.ref, visit.ref)))[0].startAt;
    expectOk(await ownerCancelBooking(world.db, visit.ref, { refundCents: 0 }, world.manageDeps({ now: hoursAfter(started, 1) })));

    // A reschedule code a refund came off.
    const second = expectOk(await world.book({ date: FAR, startMinute: h(17), durationMinutes: 60, studioIds: [world.ids.blanche] }));
    const refundedOff = expectOk(await requestRescheduleCode(world.db, second.ref, byToken(second.manageToken), world.manageDeps())).code;
    expectOk(await ownerRefund(world.db, second.ref, { amountCents: 5000, reason: "" }, world.manageDeps()));

    // Studio credit given by hand, spent by a booking its client cancelled in time: it came back whole.
    const given = (await issuePromo(world.db, { kind: "amount", value: 3000, source: "manual", email: dana.email, expiresAt: daysAfter(NOW, 90) }))!.code;
    const returned = expectOk(await world.book({ date: FAR, startMinute: h(9), durationMinutes: 60, promoCode: given, customer: dana, studioIds: [world.ids.blanche] }));
    expectOk(await cancelBooking(world.db, returned.ref, byToken(returned.manageToken), world.manageDeps()));

    // Studio credit spent on a booking whose card was refused: it came back whole.
    const refused = (await issuePromo(world.db, { kind: "amount", value: 2500, source: "manual", email: dana.email, expiresAt: daysAfter(NOW, 90) }))!.code;
    expect(
      await world.book({ date: FAR, startMinute: h(11), durationMinutes: 60, promoCode: refused, customer: dana, studioIds: [world.ids.paris], paymentToken: MOCK_TOKEN_DECLINED }),
    ).toMatchObject({ ok: false, code: "payment_failed" });

    // Studio credit spent on a booking whose hold on the time ran out before this release, which then kept the code
    // spent: the server stopped while the card was answering, and the hold ran out without giving the code back.
    const stranded = (await issuePromo(world.db, { kind: "amount", value: 2000, source: "manual", email: dana.email, expiresAt: daysAfter(NOW, 90) }))!;
    const [stuck] = await world.db
      .insert(bookings)
      .values({
        ref: "VS-STUCK1",
        customerName: dana.name,
        customerEmail: dana.email,
        startAt: new Date("2026-12-09T20:00:00Z"),
        endAt: new Date("2026-12-09T21:00:00Z"),
        durationMinutes: 60,
        status: "expired",
        studiosSubtotalCents: 7800,
        promoCodeId: stranded.id,
        promoDiscountCents: 2000,
        creditAppliedCents: 2000,
        totalCents: 5800,
        manageTokenHash: "x",
      })
      .returning({ id: bookings.id });
    await world.db.insert(payments).values({
      bookingId: stuck.id,
      provider: "mock",
      amountCents: 5800,
      status: "failed",
      error: "Interrupted before its result was recorded. Nothing was taken: a reserved amount is given back by Square by itself.",
      createdAt: NOW,
    });
    await world.db.update(promoCodes).set({ value: 0, usedCount: 1 }).where(eq(promoCodes.id, stranded.id));

    // A percent code: what it was issued for is its percent.
    await issuePromo(world.db, { kind: "percent", value: 10, source: "loyalty", email: dana.email, expiresAt: daysAfter(NOW, 60) });

    const kept = new Map((await world.db.select().from(promoCodes)).map((code) => [code.code, code.issuedCents]));
    expect(kept.get(spentThenMoved)).toBe(4000);
    expect(kept.get(partSpent)).toBe(17600);
    expect(kept.get(spentThenCancelledLate)).toBe(4000);
    expect(kept.get(refundedOff)).toBe(8800);
    expect(kept.get(given)).toBe(3000);
    expect(kept.get(refused)).toBe(2500);
    expect(kept.get(stranded.code)).toBe(2000);

    // A database from before: the figure is not there, and the migration works it out again from what it has.
    await world.db.update(promoCodes).set({ issuedCents: null });
    for (const statement of fillIn()) await world.db.execute(sql.raw(statement));
    const worked = new Map((await world.db.select().from(promoCodes)).map((code) => [code.code, code.issuedCents]));
    expect(Object.fromEntries(worked)).toEqual(Object.fromEntries(kept));
  });
});
