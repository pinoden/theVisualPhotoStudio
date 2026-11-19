import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { bookingCharges, bookings, paymentLinks, payments } from "@/db/schema";
import { MANUAL_PROVIDER } from "@/lib/payment-methods";
import { CHARGES_BLOCK_MOVE, createAdminBooking, getAppointment, moveBooking, moveOptions } from "./appointments";
import type { AuthUser } from "./auth";
import { addCharge, voidCharge } from "./charges";
import { cancelBooking, getManageOptions, ownerRefund, requestRescheduleCode, type Actor } from "./manage";
import { chargesPaidOf, owedCents } from "./money";
import { checkPayLink, sendPayLink, type PayLinkDeps } from "./pay-links";
import type { PaymentProvider } from "./payments";
import { recordHandRefund, recordStudioPayment } from "./studio-payments";
import { BASE_URL, createTestWorld, expectOk, h, minutesAfter, NEAR, NOW, type TestWorld } from "./testing";

/**
 * Which payment paid what (question 36), read as what a booking owes reads its money (`chargesPaidOf` in money.ts): what
 * came in pays the price first, then each extra charge in the order it was added; and a booking with extra charges is not
 * moved (`CHARGES_BLOCK_MOVE`). From the tester's fourth pass of 2026-11-18, whose probes these were: read payment by
 * payment, in the order they came, the same money disagreed with what the booking owed.
 */
let world: TestWorld;
let owner: AuthUser;
let square: PaymentProvider;

beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser("owner@studio.test", "owner", "Olivia");
  square = { ...world.provider, name: "square" };
});

/** Wednesday NEAR, 2 p.m. in Winter Park (EST). */
const STARTS = new Date(`${NEAR}T19:00:00Z`);
const at = (minutes: number) => minutesAfter(STARTS, minutes);
/** Wednesday 2026-12-09, three weeks on. */
const LATER_DAY = { date: "2026-12-09", startMinute: h(10), countsAsClientMove: false };
const row = async (ref: string) => (await world.db.select().from(bookings).where(eq(bookings.ref, ref)))[0];
const cash = (ref: string, amountCents: number, when: Date, note = "") => recordStudioPayment(world.db, owner, ref, { amountCents, method: "cash", note }, when);
const damage = (ref: string, amountCents: number, when: Date) => addCharge(world.db, owner, ref, { kind: "damage", amountCents, note: "Broken light stand" }, when);
const cleaning = (ref: string, amountCents: number, when: Date) => addCharge(world.db, owner, ref, { kind: "cleaning", amountCents, note: "Glitter on the floor" }, when);
const linkDeps = (now: Date, processor: PaymentProvider = square): PayLinkDeps => ({ now, baseUrl: BASE_URL, payments: processor });
const cashPayment = async (amountCents: number) =>
  (await world.db.select().from(payments).where(and(eq(payments.provider, MANUAL_PROVIDER), eq(payments.amountCents, amountCents))))[0];
const chargeOf = async (kind: "damage" | "cleaning") => (await world.db.select().from(bookingCharges).where(eq(bookingCharges.kind, kind)))[0];
const lastLinkEmail = async () => (await world.emails("payment_link")).at(-1)!.body;
/** What the owner is told when taking back a charge that was paid, and one whose money was given back. */
const PAID = (amount: string) =>
  `This charge of ${amount} was paid, at least in part. Give it back as a refund instead: the charge then stays on the client's receipt, beside the refund, and is not owed again.`;
const GIVEN_BACK = (amount: string) =>
  `This charge of ${amount} is not owed any more: what was paid for it was given back. It stays on the client's booking and receipt, beside the refund, and needs nothing more.`;

/** The client pays the processor's link `index` in full. */
async function clientPaysLink(index: number, when: Date, processor: PaymentProvider = square) {
  const link = world.links[index];
  link.state = { state: "paid", paymentId: `mock_pay_${link.linkId}`, amountCents: link.request.amountCents };
  const rows = await world.db.select().from(paymentLinks).where(eq(paymentLinks.providerLinkId, link.linkId));
  expect(await checkPayLink(world.db, rows[0].id, linkDeps(when, processor))).toBe("paid");
}

/** A booking the owner makes for Dana: Blanche, two hours on NEAR at 2 p.m., $176, paid at the studio. */
async function madeInAdmin() {
  const made = expectOk(
    await createAdminBooking(
      world.db,
      owner,
      { studioIds: [world.ids.blanche], date: NEAR, startMinute: h(14), durationMinutes: 120, customer: { name: "Dana Diaz", email: "dana@example.com", phone: "407-555-0133" } },
      { now: NOW, baseUrl: BASE_URL, processor: "square" },
    ),
  );
  return { ...made, id: (await row(made.ref)).id };
}

/**
 * The studio tries to move the booking to a later day while its visit goes on: the move, its free times and the booking's
 * page all refuse, and the booking keeps its time, its price and its label.
 */
async function expectNotMoved(ref: string, when: Date) {
  const before = await row(ref);
  const emailsBefore = (await world.emails("booking_moved")).length;
  expect(await moveBooking(world.db, owner, ref, LATER_DAY, when)).toEqual({ ok: false, reason: "not_movable", message: CHARGES_BLOCK_MOVE });
  expect(await moveOptions(world.db, owner, ref, LATER_DAY.date, when)).toEqual({ ok: false, message: CHARGES_BLOCK_MOVE });
  expect(await getAppointment(world.db, owner, ref, when)).toMatchObject({ may: { move: true }, moveBlocked: CHARGES_BLOCK_MOVE });
  const after = await row(ref);
  expect({ startAt: after.startAt, totalCents: after.totalCents, label: after.label }).toEqual({ startAt: before.startAt, totalCents: before.totalCents, label: before.label });
  expect(await world.emails("booking_moved")).toHaveLength(emailsBefore);
}

describe("taking back a charge, only while nothing was paid of it (question 36)", () => {
  it("is refused for a paid charge whose money was given back, and a later unpaid charge is still owed in full", async () => {
    const made = await madeInAdmin();
    expectOk(await cash(made.ref, 17600, STARTS, "The price"));
    expectOk(await damage(made.ref, 10000, at(30)));
    expectOk(await cash(made.ref, 10000, at(31), "For the stand"));
    // The owner gives the damage back, as the site advises for a paid charge; later in the visit, $120 of cleaning.
    expectOk(await recordHandRefund(world.db, owner, (await cashPayment(10000)).id, { amountCents: 10000, note: "Damage charge given back" }, at(36)));
    expectOk(await cleaning(made.ref, 12000, at(40)));
    const booking = await row(made.ref);
    expect(await owedCents(world.db, booking, at(41))).toBe(12000);
    // Taking back the damage would let the cleaning go unpaid: the client already has the $100 back.
    expect(await voidCharge(world.db, owner, (await chargeOf("damage")).id, "Given back already", at(45))).toEqual({ ok: false, message: GIVEN_BACK("$100") });
    expect(await owedCents(world.db, booking, at(46))).toBe(12000);
    expect((await getAppointment(world.db, owner, made.ref, at(46)))!.payments).toMatchObject({ dueCents: 12000 });
  });

  it("is refused for a paid charge while a later one is unpaid, which is still owed in full", async () => {
    const made = await madeInAdmin();
    expectOk(await cash(made.ref, 17600, STARTS));
    expectOk(await damage(made.ref, 5000, at(30)));
    expectOk(await cash(made.ref, 5000, at(31), "For the stand"));
    expectOk(await cleaning(made.ref, 6000, at(40)));
    const booking = await row(made.ref);
    expect((await chargesPaidOf(world.db, booking, at(41))).map((line) => [line.amountCents, line.paidCents, line.keptCents])).toEqual([
      [5000, 5000, 5000],
      [6000, 0, 0],
    ]);
    expect(await voidCharge(world.db, owner, (await chargeOf("damage")).id, "", at(45))).toEqual({ ok: false, message: PAID("$50") });
    expect(await owedCents(world.db, booking, at(46))).toBe(6000);
  });

  it("reads what was paid as paying the price first: charges added while the price is unpaid are unpaid, and can be taken back", async () => {
    const made = await madeInAdmin();
    expectOk(await cash(made.ref, 5000, minutesAfter(STARTS, -60), "Deposit"));
    expectOk(await damage(made.ref, 3000, at(30)));
    expectOk(await cleaning(made.ref, 4000, at(31)));
    expectOk(await cash(made.ref, 5000, at(40), "Part of what is owed"));
    const booking = await row(made.ref);
    // $100 paid of the $176 price: both charges are still to pay, $146 in all, and the payment link says so.
    expect((await chargesPaidOf(world.db, booking, at(41))).map((line) => line.paidCents)).toEqual([0, 0]);
    expect(await owedCents(world.db, booking, at(41))).toBe(14600);
    expect(await sendPayLink(world.db, owner, made.ref, linkDeps(at(42)))).toMatchObject({ ok: true, amountCents: 14600 });
    expect(await lastLinkEmail()).toContain("It includes the extra charges of your visit:\nDamage charge: Broken light stand, $30\nCleaning charge: Glitter on the floor, $40\n");
  });

  it("tells the owner a charge whose money went back to the card needs nothing more, and the booking keeps what paid its price", async () => {
    // Booked online, paid by card ($176). The damage paid in cash, then given back to the card.
    const booked = expectOk(await world.book({ startMinute: h(14) }));
    expectOk(await damage(booked.ref, 10000, at(30)));
    expectOk(await cash(booked.ref, 10000, at(31), "For the stand"));
    expectOk(await ownerRefund(world.db, booked.ref, { amountCents: 10000, reason: "Damage charge given back" }, world.manageDeps({ now: at(36) })));
    expect(await voidCharge(world.db, owner, (await chargeOf("damage")).id, "Given back already", at(40))).toEqual({ ok: false, message: GIVEN_BACK("$100") });
    expect((await getAppointment(world.db, owner, booked.ref, at(42)))!.payments).toMatchObject({ paidCents: 17600, dueCents: 0, creditLeftCents: 0 });
  });
});

describe("the payment link's email lists what is still unpaid of each charge, as its amount reads it", () => {
  it("does not list a paid charge whose money was given back", async () => {
    const made = await madeInAdmin();
    expectOk(await cash(made.ref, 17600, STARTS, "The price"));
    expectOk(await damage(made.ref, 10000, at(30)));
    expectOk(await cash(made.ref, 10000, at(31), "For the stand"));
    expectOk(await recordHandRefund(world.db, owner, (await cashPayment(10000)).id, { amountCents: 10000, note: "Damage charge given back" }, at(36)));
    expectOk(await cleaning(made.ref, 12000, at(40)));
    expect(await sendPayLink(world.db, owner, made.ref, linkDeps(at(50)))).toMatchObject({ ok: true, amountCents: 12000 });
    const body = await lastLinkEmail();
    expect(body).toContain("Amount: $120\nIt includes the extra charges of your visit:\nCleaning charge: Glitter on the floor, $120\n");
    expect(body).not.toContain("Damage charge");
  });

  it("does not list a charge paid by a payment link after a goodwill refund to the card", async () => {
    // Booked online, paid by card ($176); the damage paid through a payment link; then $30 of goodwill to the card.
    const booked = expectOk(await world.book({ startMinute: h(14) }));
    expectOk(await damage(booked.ref, 5000, at(30)));
    expect(await sendPayLink(world.db, owner, booked.ref, linkDeps(at(31), world.provider))).toMatchObject({ ok: true, amountCents: 5000 });
    await clientPaysLink(0, at(35), world.provider);
    expectOk(await ownerRefund(world.db, booked.ref, { amountCents: 3000, reason: "Sorry about the air conditioning" }, world.manageDeps({ now: at(40) })));
    expect(await owedCents(world.db, await row(booked.ref), at(41))).toBe(0);
    expectOk(await cleaning(booked.ref, 4000, at(45)));
    expect(await sendPayLink(world.db, owner, booked.ref, linkDeps(at(50), world.provider))).toMatchObject({ ok: true, amountCents: 4000 });
    const body = await lastLinkEmail();
    expect(body).toContain("Amount: $40\nIt includes the extra charges of your visit:\nCleaning charge: Glitter on the floor, $40\n");
    expect(body).not.toContain("Damage charge");
  });

  it("does not list a charge paid by what was paid beyond the price, and lists what is left of the next", async () => {
    // Booked online for a Saturday ($190), moved by the studio to Wednesday NEAR ($176): $14 paid beyond the price.
    const booked = expectOk(await world.book({ date: "2026-12-12", startMinute: h(10) }));
    expectOk(await moveBooking(world.db, owner, booked.ref, { date: NEAR, startMinute: h(14), countsAsClientMove: false }, NOW));
    expectOk(await cleaning(booked.ref, 1000, at(30)));
    expectOk(await damage(booked.ref, 5000, at(40)));
    // $176 + $10 + $50 - $190 = $46: the cleaning is paid, and $4 of the damage.
    expect(await sendPayLink(world.db, owner, booked.ref, linkDeps(at(50), world.provider))).toMatchObject({ ok: true, amountCents: 4600 });
    const body = await lastLinkEmail();
    expect(body).toContain("Amount: $46\nIt includes the extra charges of your visit:\nDamage charge: Broken light stand, $46\n");
    expect(body).not.toContain("Cleaning charge");
  });

  it("reads a link made for the price before a charge, and paid after it, as paying the price: the next link is for the charge", async () => {
    const made = await madeInAdmin();
    // The day before the visit, the owner emails a link for the price.
    expect(await sendPayLink(world.db, owner, made.ref, linkDeps(NOW))).toMatchObject({ ok: true, amountCents: 17600 });
    expect(await lastLinkEmail()).not.toContain("extra charges");
    // In the visit, a $50 damage charge; the client pays the $176 link afterwards.
    expectOk(await damage(made.ref, 5000, at(30)));
    await clientPaysLink(0, at(40));
    expect((await getAppointment(world.db, owner, made.ref, at(41)))!.payments).toMatchObject({ dueCents: 5000 });
    expect(await sendPayLink(world.db, owner, made.ref, linkDeps(at(45)))).toMatchObject({ ok: true, amountCents: 5000 });
    expect(await lastLinkEmail()).toContain("Amount: $50\nIt includes the extra charges of your visit:\nDamage charge: Broken light stand, $50\n");
  });

  it("lists what is left of a charge paid in part", async () => {
    const made = await madeInAdmin();
    expectOk(await cash(made.ref, 17600, STARTS));
    expectOk(await damage(made.ref, 10000, at(30)));
    expectOk(await cash(made.ref, 4000, at(31), "Part of the stand"));
    expect(await sendPayLink(world.db, owner, made.ref, linkDeps(at(40)))).toMatchObject({ ok: true, amountCents: 6000 });
    expect(await lastLinkEmail()).toContain("Amount: $60\nIt includes the extra charges of your visit:\nDamage charge: Broken light stand, $60\n");
  });
});

describe("a booking with extra charges is not moved (the tester's fourth pass of 2026-11-18)", () => {
  it("whether its charge is unpaid, paid, or paid and given back", async () => {
    const made = await madeInAdmin();
    expectOk(await cash(made.ref, 17600, STARTS));
    expectOk(await damage(made.ref, 10000, at(30)));
    await expectNotMoved(made.ref, at(31));
    expectOk(await cash(made.ref, 10000, at(32), "For the stand"));
    await expectNotMoved(made.ref, at(33));
    expectOk(await recordHandRefund(world.db, owner, (await cashPayment(10000)).id, { amountCents: 10000, note: "Damage charge given back" }, at(34)));
    await expectNotMoved(made.ref, at(45));
    // Its visit has started: the client is offered neither a cancellation with a refund nor a reschedule code.
    const actor: Actor = { kind: "token", token: made.manageToken };
    expect(await getManageOptions(world.db, made.ref, actor, at(50))).toMatchObject({
      cancel: { allowed: false, reason: "already_started" },
      reschedule: { allowed: false, reason: "already_started" },
    });
  });

  it("when its charge was paid by what was paid beyond its price, which stays the client's", async () => {
    // Booked online for a Saturday ($190), moved by the studio to Wednesday NEAR ($176): $14 paid beyond the price.
    const booked = expectOk(await world.book({ date: "2026-12-12", startMinute: h(10) }));
    expectOk(await moveBooking(world.db, owner, booked.ref, { date: NEAR, startMinute: h(14), countsAsClientMove: false }, NOW));
    expect((await getAppointment(world.db, owner, booked.ref, NOW))!.payments).toMatchObject({ dueCents: 0, creditLeftCents: 1400 });
    // In the visit, a $10 cleaning charge: the $14 beyond the price pays it, and $4 is left.
    expectOk(await cleaning(booked.ref, 1000, at(30)));
    await expectNotMoved(booked.ref, at(45));
    expect((await getAppointment(world.db, owner, booked.ref, at(46)))!.payments).toMatchObject({ dueCents: 0, creditLeftCents: 400 });
  });

  it("when a link for its price was paid after a charge was added", async () => {
    const made = await madeInAdmin();
    expect(await sendPayLink(world.db, owner, made.ref, linkDeps(NOW))).toMatchObject({ ok: true, amountCents: 17600 });
    expectOk(await damage(made.ref, 5000, at(30)));
    await clientPaysLink(0, at(40));
    await expectNotMoved(made.ref, at(45));
  });

  it("when a charge paid in cash went back to the card", async () => {
    const booked = expectOk(await world.book({ startMinute: h(14) }));
    expectOk(await damage(booked.ref, 10000, at(30)));
    expectOk(await cash(booked.ref, 10000, at(31), "For the stand"));
    expectOk(await ownerRefund(world.db, booked.ref, { amountCents: 10000, reason: "Damage charge given back" }, world.manageDeps({ now: at(36) })));
    await expectNotMoved(booked.ref, at(45));
  });
});

describe("a client's own cancellation and reschedule, with no charges (a control)", () => {
  it("refunds 95% of the card, and the reschedule code is worth what was paid", async () => {
    const booked = expectOk(await world.book({ date: "2026-12-09" }));
    const cancelled = expectOk(await cancelBooking(world.db, booked.ref, { kind: "token", token: booked.manageToken }, world.manageDeps()));
    expect(cancelled.refundCents).toBe(16720);
    const second = expectOk(await world.book({ date: "2026-12-10" }));
    const released = expectOk(await requestRescheduleCode(world.db, second.ref, { kind: "token", token: second.manageToken }, world.manageDeps()));
    expect(released.valueCents).toBe(17600);
  });
});
