import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BookingSummary } from "@/components/BookingSummary";
import { bookingCharges, bookingEvents, bookings, emailTemplates, payments, priceRules, settings, specialDates, staffShifts } from "@/db/schema";
import { EMAIL_TEMPLATES } from "@/lib/email-templates";
import { MANUAL_PROVIDER } from "@/lib/payment-methods";
import { createAdminBooking, getAppointment, moveBooking } from "./appointments";
import type { AuthUser } from "./auth";
import { toBookingViews } from "./bookings";
import { addCharge, CHARGE_MAX_CENTS, hourlyRateOf, overtimeCents, voidCharge } from "./charges";
import { getManageChoices, getManageOptions, ownerCancelBooking, type Actor } from "./manage";
import { owedCents } from "./money";
import { sendPayLink, type PayLinkDeps } from "./pay-links";
import { loadReceipts } from "./receipts";
import { recordHandRefund, recordStudioPayment } from "./studio-payments";
import { BASE_URL, createTestWorld, expectOk, h, minutesAfter, NEAR, NOW, OWNER_EMAIL, type TestWorld } from "./testing";

/**
 * Follow-up 13, the owner's answer of 2026-11-17: overtime at the studio's hourly rate, each 15 minutes started a
 * quarter of it; cleaning and damage at an amount typed each time; paid at the studio or by payment link.
 */
let world: TestWorld;
let owner: AuthUser;
let sam: AuthUser; // staff, assigned to NEAR

beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser("owner@studio.test", "owner", "Olivia");
  sam = await world.addUser("sam@studio.test", "staff", "Sam");
  await world.db.insert(staffShifts).values({ userId: sam.id, day: NEAR });
});

/** Wednesday NEAR, 2 p.m. in Winter Park (EST): when the booking below starts, and two hours later, when it ends. */
const STARTS = new Date(`${NEAR}T19:00:00Z`);
const ENDS = minutesAfter(STARTS, 120);
const row = async (ref: string) => (await world.db.select().from(bookings).where(eq(bookings.ref, ref)))[0];
const allow = (key: string, value = true) =>
  world.db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
const overtime = (minutes: number, note = "") => ({ kind: "overtime" as const, minutes, note });
const cleaning = (amountCents: number, note = "Glitter on the cyclorama") => ({ kind: "cleaning" as const, amountCents, note });
/** A booking the owner makes for Dana: Blanche (or the studios given), two hours on NEAR, $176, paid at the studio. */
async function madeInAdmin(studioIds = [world.ids.blanche]) {
  const made = expectOk(
    await createAdminBooking(
      world.db,
      owner,
      { studioIds, date: NEAR, startMinute: h(14), durationMinutes: 120, customer: { name: "Dana Diaz", email: "dana@example.com", phone: "407-555-0133" } },
      { now: NOW, baseUrl: BASE_URL, processor: "square" },
    ),
  );
  return { ...made, id: (await row(made.ref)).id };
}

describe("overtime", () => {
  it("costs a quarter of the hourly rate for each 15 minutes started", () => {
    expect([1, 15, 16, 20, 30, 31, 60].map((minutes) => overtimeCents(8800, minutes))).toEqual([2200, 2200, 4400, 4400, 4400, 6600, 8800]);
    // A quarter of $95 is $23.75; of $142.50, $35.625, which rounds to the cent.
    expect(overtimeCents(9500, 10)).toBe(2375);
    expect(overtimeCents(14250, 5)).toBe(3563);
  });

  it("is worked out from the one-hour price of the booking's studios for its day, added together", async () => {
    const blanche = await madeInAdmin();
    expect(await hourlyRateOf(world.db, { id: blanche.id, startAt: STARTS })).toEqual({ ok: true, cents: 8800 });
    // A day the owners price as a weekend day: the weekend price.
    await world.db.insert(specialDates).values({ day: NEAR, dayType: "weekend" });
    expect(await hourlyRateOf(world.db, { id: blanche.id, startAt: STARTS })).toEqual({ ok: true, cents: 9500 });
    await world.db.delete(specialDates);
    // Paris and Dayglow together: $68 + $78.
    const bundle = expectOk(
      await createAdminBooking(
        world.db,
        owner,
        { studioIds: [world.ids.paris, world.ids.dayglow], date: NEAR, startMinute: h(17), durationMinutes: 60, customer: { name: "Eve", email: "eve@example.com", phone: "407-555-0144" } },
        { now: NOW, baseUrl: BASE_URL },
      ),
    );
    const bundleRow = await row(bundle.ref);
    expect(await hourlyRateOf(world.db, bundleRow)).toEqual({ ok: true, cents: 14600 });
    expect(await addCharge(world.db, owner, bundle.ref, overtime(20), minutesAfter(bundleRow.endAt, 20))).toMatchObject({ ok: true, amountCents: 7300 });
  });

  it("is added once the appointment has started, and the booking then owes it", async () => {
    const made = await madeInAdmin();
    expect(await addCharge(world.db, owner, made.ref, overtime(20), minutesAfter(STARTS, -1))).toEqual({
      ok: false,
      message: "A charge can be added once the appointment has started.",
    });
    expect(await addCharge(world.db, owner, made.ref, overtime(20, "Stayed to pack up"), minutesAfter(ENDS, 20))).toEqual({ ok: true, amountCents: 4400, dueCents: 22000 });
    const booking = await row(made.ref);
    expect(await owedCents(world.db, booking, ENDS)).toBe(22000);
    expect(await world.db.select().from(bookingCharges)).toMatchObject([
      { kind: "overtime", amountCents: 4400, minutes: 20, hourlyCents: 8800, note: "Stayed to pack up", createdBy: "owner@studio.test", voidedAt: null },
    ]);
    const [event] = await world.db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, made.id)).orderBy(bookingEvents.at).limit(10).then((rows) => rows.slice(-1));
    expect(event.note).toBe("Overtime of 20 minutes added: $44 (2 × 15 minutes started, each a quarter of $88 an hour): Stayed to pack up; $220 to pay");

    // The appointment's page lists it, and the price summary shows it as a line.
    const appointment = (await getAppointment(world.db, owner, made.ref, minutesAfter(ENDS, 25)))!;
    expect(appointment.charges).toMatchObject({ canAdd: true, overtime: true, hourlyCents: 8800, lines: [{ label: "Overtime, 20 minutes", amountCents: 4400, voided: false }] });
    expect(appointment.payments).toMatchObject({ dueCents: 22000 });
    const [view] = await toBookingViews(world.db, [booking], ENDS);
    expect(view).toMatchObject({ totalCents: 17600, charges: [{ label: "Overtime, 20 minutes", cents: 4400 }], chargesCents: 4400, dueCents: 22000 });
    const html = renderToStaticMarkup(createElement(BookingSummary, { booking: view }));
    expect(html).toContain("Overtime, 20 minutes");
    expect(html).toContain("$220");
  });

  it("needs a one-hour price for the day, and is not for a photography session", async () => {
    const made = await madeInAdmin();
    await world.db.delete(priceRules).where(and(eq(priceRules.studioId, world.ids.blanche), eq(priceRules.dayType, "weekday"), eq(priceRules.durationMinutes, 60)));
    expect(await addCharge(world.db, owner, made.ref, overtime(20), ENDS)).toEqual({
      ok: false,
      message:
        "Studio Blanche has no one-hour price for this day under Prices, so overtime cannot be worked out. Add the price, or add the amount as a cleaning or damage charge.",
    });
    expect((await getAppointment(world.db, owner, made.ref, ENDS))!.charges).toMatchObject({ hourlyCents: null, missingRate: ["Studio Blanche"] });
    // Cleaning still can be.
    expectOk(await addCharge(world.db, owner, made.ref, cleaning(5000), ENDS));
    await world.db.update(bookings).set({ photographerId: (await world.db.query.photographers.findFirst())!.id }).where(eq(bookings.id, made.id));
    expect(await addCharge(world.db, owner, made.ref, overtime(20), ENDS)).toEqual({ ok: false, message: "Overtime is for a studio rental, not a photography session." });
  });

  it("takes whole minutes, from 1 to 600", async () => {
    const made = await madeInAdmin();
    for (const minutes of [0, -5, 601, 1.5, Number.NaN]) {
      expect(await addCharge(world.db, owner, made.ref, overtime(minutes), ENDS)).toEqual({ ok: false, message: "Enter the minutes past the end, from 1 to 600." });
    }
    expect(await addCharge(world.db, owner, made.ref, overtime(600), ENDS)).toMatchObject({ ok: true, amountCents: 88000 });
  });
});

describe("cleaning and damage", () => {
  it("are an amount typed each time, with what it is for", async () => {
    const made = await madeInAdmin();
    expect(await addCharge(world.db, owner, made.ref, cleaning(5000, "  "), ENDS)).toEqual({
      ok: false,
      message: "Say what the cleaning charge is for: the client sees it on the receipt.",
    });
    for (const amountCents of [0, -100, CHARGE_MAX_CENTS + 1, 12.5]) {
      expect(await addCharge(world.db, owner, made.ref, cleaning(amountCents), ENDS)).toEqual({
        ok: false,
        message: "Enter the amount of the charge, above zero and at most $10,000.",
      });
    }
    expect(await addCharge(world.db, owner, made.ref, cleaning(5000), ENDS)).toEqual({ ok: true, amountCents: 5000, dueCents: 22600 });
    expect(await addCharge(world.db, owner, made.ref, { kind: "damage", amountCents: 12000, note: "Broken backdrop stand" }, ENDS)).toEqual({
      ok: true,
      amountCents: 12000,
      dueCents: 34600,
    });
    const notes = (await world.db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, made.id))).map((event) => event.note);
    expect(notes).toContain("Cleaning charge of $50 added: Glitter on the cyclorama; $226 to pay");
    expect(notes).toContain("Damage charge of $120 added: Broken backdrop stand; $346 to pay");
  });

  it("are not added to a booking that was cancelled", async () => {
    const made = await madeInAdmin();
    expectOk(await ownerCancelBooking(world.db, made.ref, { refundCents: 0 }, world.manageDeps()));
    expect(await addCharge(world.db, owner, made.ref, cleaning(5000), ENDS)).toEqual({
      ok: false,
      message: "A charge can be added to a booking that is confirmed or has taken place, not to a cancelled one.",
    });
  });
});

describe("paying a charge", () => {
  it("is done at the studio, recorded like the rest, or through a payment link for all that is owed", async () => {
    const made = await madeInAdmin();
    expectOk(await recordStudioPayment(world.db, owner, made.ref, { amountCents: 17600, method: "card", note: "" }, STARTS));
    expect((await getAppointment(world.db, owner, made.ref, ENDS))!.may.recordPayment).toBe(false);
    expect(await addCharge(world.db, owner, made.ref, overtime(10), ENDS)).toEqual({ ok: true, amountCents: 2200, dueCents: 2200 });
    expect((await getAppointment(world.db, owner, made.ref, ENDS))!.may.recordPayment).toBe(true);
    expect(await recordStudioPayment(world.db, owner, made.ref, { amountCents: 2201, method: "cash", note: "" }, ENDS)).toMatchObject({
      ok: false,
      message: "Only $22 is still to pay for this booking.",
    });
    expectOk(await addCharge(world.db, owner, made.ref, cleaning(3000), ENDS));
    const deps: PayLinkDeps = { now: ENDS, baseUrl: BASE_URL, payments: { ...world.provider, name: "square" } };
    expect(await sendPayLink(world.db, owner, made.ref, deps)).toEqual({ ok: true, amountCents: 5200, again: false });
  });

  it("shows on the client's receipt, with what the booking cost in all", async () => {
    const made = await madeInAdmin();
    expectOk(await recordStudioPayment(world.db, owner, made.ref, { amountCents: 17600, method: "card", note: "" }, STARTS));
    expectOk(await addCharge(world.db, owner, made.ref, overtime(20), ENDS));
    let [receipt] = (await loadReceipts(world.db, "dana@example.com")).receipts;
    expect(receipt.lines.at(-1)).toEqual({ label: "Overtime, 20 minutes", cents: 4400 });
    expect(receipt).toMatchObject({ totalCents: 22000, paidCents: 17600, dueCents: 4400, status: "partly_paid" });
    expectOk(await recordStudioPayment(world.db, owner, made.ref, { amountCents: 4400, method: "cash", note: "" }, ENDS));
    [receipt] = (await loadReceipts(world.db, "dana@example.com")).receipts;
    expect(receipt).toMatchObject({ totalCents: 22000, paidCents: 22000, dueCents: 0, status: "paid" });
  });
});

describe("what a charge is for, and where its money goes (the tester's findings of 2026-11-18)", () => {
  it("names what a cleaning or damage charge is for, on the client's booking, receipt and payment link", async () => {
    const made = await madeInAdmin();
    expectOk(await recordStudioPayment(world.db, owner, made.ref, { amountCents: 17600, method: "cash", note: "" }, STARTS));
    expectOk(await addCharge(world.db, owner, made.ref, { kind: "damage", amountCents: 10000, note: "Broken light stand" }, ENDS));
    expectOk(await addCharge(world.db, owner, made.ref, overtime(20, "Packing up"), ENDS));
    const [view] = await toBookingViews(world.db, [await row(made.ref)], ENDS);
    // Overtime says how long; its note is the studio's own.
    expect(view.charges.map((charge) => charge.label)).toEqual(["Damage charge: Broken light stand", "Overtime, 20 minutes"]);
    const [receipt] = (await loadReceipts(world.db, "dana@example.com")).receipts;
    expect(receipt.lines.slice(-2)).toEqual([
      { label: "Damage charge: Broken light stand", cents: 10000 },
      { label: "Overtime, 20 minutes", cents: 4400 },
    ]);
    expectOk(await sendPayLink(world.db, owner, made.ref, { now: ENDS, baseUrl: BASE_URL, payments: { ...world.provider, name: "square" } }));
    expect((await world.emails("payment_link")).at(-1)!.body).toContain(
      "Amount: $144\nIt includes the extra charges of your visit:\nDamage charge: Broken light stand, $100\nOvertime, 20 minutes, $44\n",
    );
  });

  it("never travels into a reschedule code or a cancellation refund, even once the studio moved the booking after it started", async () => {
    const made = await madeInAdmin();
    expectOk(await recordStudioPayment(world.db, owner, made.ref, { amountCents: 17600, method: "cash", note: "" }, STARTS));
    // Half an hour in, a stand breaks: $100 of damage, paid at once. The shoot is cut short, and moved to a later day.
    expectOk(await addCharge(world.db, owner, made.ref, { kind: "damage", amountCents: 10000, note: "Broken light stand" }, minutesAfter(STARTS, 30)));
    expectOk(await recordStudioPayment(world.db, owner, made.ref, { amountCents: 10000, method: "cash", note: "" }, minutesAfter(STARTS, 31)));
    expectOk(await moveBooking(world.db, owner, made.ref, { date: "2026-12-09", startMinute: h(10), countsAsClientMove: false }, minutesAfter(STARTS, 45)));
    const actor: Actor = { kind: "token", token: made.manageToken };
    const later = minutesAfter(STARTS, 50);
    // The reschedule code carries the $176 the booking was paid, not the damage.
    expect((await getManageOptions(world.db, made.ref, actor, later))!.reschedule).toMatchObject({ allowed: true, creditCents: 17600 });
    // A cancellation in time gives back what was paid at the studio for the booking: 95% of $176, not of $276.
    const choices = (await getManageChoices(world.db, made.ref, actor, later))!;
    expect(choices.cancel.text).toContain("$167.20");
    expect(choices.cancel.text).not.toContain("$262.20");
  });
});


// The tester's third pass of 2026-11-18: which money paid what (`moneyByPurposeOf`).
const LATER_DAY = { date: "2026-12-09", startMinute: h(10), countsAsClientMove: false };
const cash = (ref: string, amountCents: number, at: Date, note = "") => recordStudioPayment(world.db, owner, ref, { amountCents, method: "cash", note }, at);
const damage = (ref: string, amountCents: number, at: Date) => addCharge(world.db, owner, ref, { kind: "damage", amountCents, note: "Broken light stand" }, at);
/** What the client is offered after the studio moved the booking: the cancellation and the reschedule code. */
async function clientOptions(ref: string, manageToken: string, at: Date) {
  const actor: Actor = { kind: "token", token: manageToken };
  const options = (await getManageOptions(world.db, ref, actor, at))!;
  const choices = (await getManageChoices(world.db, ref, actor, at))!;
  return { options, cancelText: choices.cancel.text, rescheduleText: choices.reschedule.text };
}

describe("a paid extra charge, once the studio moved a booking that had started (the tester's third pass of 2026-11-18)", () => {
  it("does not give back the damage payment when the price itself was not paid yet", async () => {
    const made = await madeInAdmin();
    // Half an hour in, a stand breaks: $100 of damage, paid in cash at once. The price was to be paid at the end.
    expectOk(await damage(made.ref, 10000, minutesAfter(STARTS, 30)));
    expectOk(await cash(made.ref, 10000, minutesAfter(STARTS, 31), "For the stand"));
    // The shoot is cut short, and the studio moves the booking to a later day.
    expectOk(await moveBooking(world.db, owner, made.ref, LATER_DAY, minutesAfter(STARTS, 45)));
    const { options, cancelText, rescheduleText } = await clientOptions(made.ref, made.manageToken, minutesAfter(STARTS, 50));
    // Nothing was paid toward the price: a cancellation gives nothing back, and there is no credit to move.
    expect({ cancel: options.cancel, reschedule: options.reschedule }, `Cancel: "${cancelText}" Move: "${rescheduleText}"`).toMatchObject({
      cancel: { byHandCents: 0, refundCents: 0 },
      reschedule: { allowed: false, reason: "nothing_paid" },
    });
  });

  it("does not give back the damage payment when the price was paid only in part", async () => {
    const made = await madeInAdmin();
    expectOk(await cash(made.ref, 10000, STARTS, "Deposit"));
    expectOk(await damage(made.ref, 5000, minutesAfter(STARTS, 30)));
    expectOk(await cash(made.ref, 5000, minutesAfter(STARTS, 31), "For the stand"));
    expectOk(await moveBooking(world.db, owner, made.ref, LATER_DAY, minutesAfter(STARTS, 45)));
    const { options, cancelText, rescheduleText } = await clientOptions(made.ref, made.manageToken, minutesAfter(STARTS, 50));
    // $100 was paid toward the price: 95% of it ($95) is given back, not 95% of the $150 that includes the damage.
    expect({ cancel: options.cancel, reschedule: options.reschedule }, `Cancel: "${cancelText}" Move: "${rescheduleText}"`).toMatchObject({
      cancel: { byHandCents: 10000 },
      reschedule: { creditCents: 10000 },
    });
  });

  it("tells the owner a paid charge whose money was given back needs nothing more, and is not owed again", async () => {
    const made = await madeInAdmin();
    expectOk(await cash(made.ref, 17600, STARTS));
    expectOk(await damage(made.ref, 10000, minutesAfter(STARTS, 30)));
    expectOk(await cash(made.ref, 10000, minutesAfter(STARTS, 31), "For the stand"));
    const [charge] = await world.db.select().from(bookingCharges);
    // The stand was already cracked: the owner takes the charge back. The site refuses, and says to refund it instead.
    const voided = await voidCharge(world.db, owner, charge.id, "It was cracked before", minutesAfter(STARTS, 35));
    expect(voided).toMatchObject({ ok: false, message: expect.stringContaining("Give it back as a refund instead") });
    const [forStand] = await world.db
      .select()
      .from(payments)
      .where(and(eq(payments.provider, MANUAL_PROVIDER), eq(payments.amountCents, 10000)));
    expectOk(await recordHandRefund(world.db, owner, forStand.id, { amountCents: 10000, note: "Damage charge given back" }, minutesAfter(STARTS, 36)));
    // Its money given back, the refund undid it: the charge stays on the receipt beside the refund, is not owed again, and
    // the owner is told so rather than to refund it again (the builder's reading, recorded in ProjectLibrary.md).
    expect(await voidCharge(world.db, owner, charge.id, "Given back", minutesAfter(STARTS, 37))).toEqual({
      ok: false,
      message:
        "This charge of $100 is not owed any more: what was paid for it was given back, or the booking had been paid beyond its price. It stays on the client's booking and receipt, and needs nothing more.",
    });
    expect((await getAppointment(world.db, owner, made.ref, minutesAfter(STARTS, 37)))!.payments).toMatchObject({ dueCents: 0, creditLeftCents: 0 });
  });

  it("gives the client back what they paid for the booking when a paid charge was refunded before the move", async () => {
    const made = await madeInAdmin();
    expectOk(await cash(made.ref, 17600, STARTS));
    expectOk(await damage(made.ref, 10000, minutesAfter(STARTS, 30)));
    expectOk(await cash(made.ref, 10000, minutesAfter(STARTS, 31), "For the stand"));
    const [forStand] = await world.db
      .select()
      .from(payments)
      .where(and(eq(payments.provider, MANUAL_PROVIDER), eq(payments.amountCents, 10000)));
    expectOk(await recordHandRefund(world.db, owner, forStand.id, { amountCents: 10000, note: "Damage charge given back" }, minutesAfter(STARTS, 36)));
    expectOk(await moveBooking(world.db, owner, made.ref, LATER_DAY, minutesAfter(STARTS, 45)));
    const { options, cancelText, rescheduleText } = await clientOptions(made.ref, made.manageToken, minutesAfter(STARTS, 50));
    // The client kept $176 with the studio, for the booking: 95% of it is given back ($167.20).
    expect({ cancel: options.cancel, reschedule: options.reschedule }, `Cancel: "${cancelText}" Move: "${rescheduleText}"`).toMatchObject({
      cancel: { byHandCents: 17600 },
      reschedule: { allowed: true, creditCents: 17600 },
    });
  });
});

describe("a paid extra charge given back, or taken back, before the studio moved the booking", () => {
  it("gives back what the card paid for an online booking when the damage, paid in cash, was given back before the move", async () => {
    // Booked online for 2 p.m. and paid by card ($176); the damage paid in cash and given back by hand.
    const booked = expectOk(await world.book({ startMinute: h(14) }));
    expectOk(await damage(booked.ref, 10000, minutesAfter(STARTS, 30)));
    expectOk(await cash(booked.ref, 10000, minutesAfter(STARTS, 31), "For the stand"));
    const [forStand] = await world.db
      .select()
      .from(payments)
      .where(and(eq(payments.provider, MANUAL_PROVIDER), eq(payments.amountCents, 10000)));
    expectOk(await recordHandRefund(world.db, owner, forStand.id, { amountCents: 10000, note: "Damage charge given back" }, minutesAfter(STARTS, 36)));
    expectOk(await moveBooking(world.db, owner, booked.ref, LATER_DAY, minutesAfter(STARTS, 45)));
    const { options, cancelText, rescheduleText } = await clientOptions(booked.ref, booked.manageToken, minutesAfter(STARTS, 50));
    // The card paid $176 for the booking and kept it: 95% of it goes back to the card ($167.20).
    expect({ cancel: options.cancel, reschedule: options.reschedule }, `Cancel: "${cancelText}" Move: "${rescheduleText}"`).toMatchObject({
      cancel: { refundCents: 16720, byHandCents: 0 },
      reschedule: { allowed: true, creditCents: 17600 },
    });
  });

  it("is not changed by a charge taken back before the move", async () => {
    const made = await madeInAdmin();
    expectOk(await cash(made.ref, 17600, STARTS));
    expectOk(await damage(made.ref, 10000, minutesAfter(STARTS, 30)));
    const [charge] = await world.db.select().from(bookingCharges);
    expectOk(await voidCharge(world.db, owner, charge.id, "Added to the wrong booking", minutesAfter(STARTS, 35)));
    expectOk(await moveBooking(world.db, owner, made.ref, LATER_DAY, minutesAfter(STARTS, 45)));
    const { options } = await clientOptions(made.ref, made.manageToken, minutesAfter(STARTS, 50));
    expect({ cancel: options.cancel, reschedule: options.reschedule }).toMatchObject({ cancel: { byHandCents: 17600 }, reschedule: { creditCents: 17600 } });
  });
});

describe("the owners' wording of the payment link saved before {{charges}} existed", () => {
  it("is not used: the site's wording, with the charges, is sent", async () => {
    const spec = EMAIL_TEMPLATES.payment_link;
    const body = spec.body.split("\n").filter((line) => !line.includes("{{charges}}")).join("\n").replace("You can pay", "Pay online");
    await world.db.insert(emailTemplates).values({ key: "payment_link", subject: spec.subject, body, revision: 1, updatedBy: OWNER_EMAIL, updatedAt: NOW });
    const made = await madeInAdmin();
    expectOk(await cash(made.ref, 17600, STARTS));
    expectOk(await damage(made.ref, 10000, minutesAfter(STARTS, 30)));
    expectOk(await sendPayLink(world.db, owner, made.ref, { now: minutesAfter(STARTS, 40), baseUrl: BASE_URL, payments: { ...world.provider, name: "square" } }));
    const sent = (await world.emails("payment_link")).at(-1)!.body;
    expect(sent).toContain("It includes the extra charges of your visit:\nDamage charge: Broken light stand, $100");
    expect(sent).not.toContain("Pay online");
  });
});

describe("the payment link's email lists the charges its amount includes", () => {
  it("does not list a charge already paid at the studio as included in the amount", async () => {
    const made = await madeInAdmin();
    expectOk(await cash(made.ref, 17600, STARTS));
    expectOk(await damage(made.ref, 10000, minutesAfter(STARTS, 30)));
    expectOk(await cash(made.ref, 10000, minutesAfter(STARTS, 31), "For the stand"));
    expectOk(await addCharge(world.db, owner, made.ref, { kind: "overtime", minutes: 20, note: "" }, ENDS));
    expectOk(await sendPayLink(world.db, owner, made.ref, { now: minutesAfter(ENDS, 25), baseUrl: BASE_URL, payments: { ...world.provider, name: "square" } }));
    const body = (await world.emails("payment_link")).at(-1)!.body;
    expect(body).toContain("Amount: $44");
    // The $100 was paid in cash already: the $44 does not include it.
    expect(body).not.toContain("Damage charge: Broken light stand, $100");
  });
});

describe("who adds and takes back a charge", () => {
  it("staff who may record payments add one on their days; only an owner takes one back", async () => {
    const made = await madeInAdmin();
    expect(await addCharge(world.db, sam, made.ref, overtime(20), ENDS)).toEqual({ ok: false, message: "You cannot add charges." });
    expect((await getAppointment(world.db, sam, made.ref, ENDS))!.charges).toBeNull();
    await allow("staffRecordsPayments");
    expect(await addCharge(world.db, sam, made.ref, overtime(20), ENDS)).toMatchObject({ ok: true, amountCents: 4400 });
    const [charge] = await world.db.select().from(bookingCharges);
    expect(charge.createdBy).toBe("sam@studio.test");
    expect(await voidCharge(world.db, sam, charge.id, "", ENDS)).toEqual({ ok: false, message: "Only an owner can take a charge back." });
    // Not on a day that is not theirs.
    await world.db.delete(staffShifts);
    expect(await addCharge(world.db, sam, made.ref, overtime(5), ENDS)).toEqual({ ok: false, message: "You cannot add a charge to that booking." });
  });

  it("is taken back while it is unpaid, and then no longer counts", async () => {
    const made = await madeInAdmin();
    expectOk(await addCharge(world.db, owner, made.ref, cleaning(5000), ENDS));
    const [charge] = await world.db.select().from(bookingCharges);
    expect(await voidCharge(world.db, owner, charge.id, "Wrong booking", ENDS)).toEqual({ ok: true });
    expect(await voidCharge(world.db, owner, charge.id, "", ENDS)).toEqual({ ok: false, message: "That charge was already taken back." });
    expect(await owedCents(world.db, await row(made.ref), ENDS)).toBe(17600);
    const appointment = (await getAppointment(world.db, owner, made.ref, ENDS))!;
    expect(appointment.charges!.lines).toMatchObject([{ voided: true, voidedBy: "owner@studio.test" }]);
    const notes = (await world.db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, made.id))).map((event) => event.note);
    expect(notes).toContain("Cleaning charge of $50 taken back: Wrong booking");
    expect((await toBookingViews(world.db, [await row(made.ref)], ENDS))[0]).toMatchObject({ charges: [], chargesCents: 0 });
  });

  it("is not taken back once it was paid, nor while a payment link asks for it", async () => {
    const made = await madeInAdmin();
    expectOk(await addCharge(world.db, owner, made.ref, cleaning(5000), ENDS));
    const [charge] = await world.db.select().from(bookingCharges);
    const deps: PayLinkDeps = { now: ENDS, baseUrl: BASE_URL, payments: { ...world.provider, name: "square" } };
    expectOk(await sendPayLink(world.db, owner, made.ref, deps));
    expect(await voidCharge(world.db, owner, charge.id, "", ENDS)).toEqual({
      ok: false,
      message: "A payment link for $226 is open for this booking. Cancel the link first, then take the charge back.",
    });
    const other = await madeInAdmin([world.ids.paris]);
    expectOk(await recordStudioPayment(world.db, owner, other.ref, { amountCents: 13600, method: "cash", note: "" }, STARTS));
    expectOk(await addCharge(world.db, owner, other.ref, cleaning(5000), ENDS));
    expectOk(await recordStudioPayment(world.db, owner, other.ref, { amountCents: 2000, method: "cash", note: "Part of it" }, ENDS));
    const otherCharge = (await world.db.select().from(bookingCharges).where(eq(bookingCharges.bookingId, other.id)))[0];
    expect(await voidCharge(world.db, owner, otherCharge.id, "", ENDS)).toEqual({
      ok: false,
      message: "This charge of $50 was paid, at least in part. Give it back as a refund instead: the charge then stays on the client's receipt, beside the refund, and is not owed again.",
    });
  });
});
