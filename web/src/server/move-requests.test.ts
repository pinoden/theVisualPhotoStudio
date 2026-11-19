import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookingEvents, bookings, emailOutbox } from "@/db/schema";
import { moveBooking } from "./appointments";
import type { AuthUser } from "./auth";
import { askStudioToMove, cancelBooking, getManageChoices, MOVE_REQUEST_MAX, type Actor } from "./manage";
import { BASE_URL, createTestWorld, expectOk, FAR, h, hoursAfter, NOW, OWNER_EMAIL, type TestWorld } from "./testing";

/** Question 20 of 2026-11-17: a client can also ask the studio to move a booking, beside the instant reschedule code. */
let world: TestWorld;
let owner: AuthUser;
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser(OWNER_EMAIL, "owner", "Olivia");
});

const byToken = (token: string): Actor => ({ kind: "token", token });
const deps = (now = NOW, ownerEmail: string | null = OWNER_EMAIL) => ({ now, ownerEmail, baseUrl: BASE_URL });
const row = async (ref: string) => (await world.db.select().from(bookings).where(eq(bookings.ref, ref)))[0];
const FAR_START = new Date(`${FAR}T15:00:00Z`); // FAR at 10:00 local

describe("asking the studio to move a booking", () => {
  it("marks it Reschedule Pending, keeps what the client wrote, and tells the studio and the client", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    expect((await getManageChoices(world.db, booked.ref, byToken(booked.manageToken), NOW))!.request).toMatchObject({ allowed: true });

    expect(await askStudioToMove(world.db, booked.ref, byToken(booked.manageToken), "  Any weekday afternoon next week  ", deps())).toEqual({ ok: true });
    const booking = await row(booked.ref);
    expect(booking).toMatchObject({ status: "confirmed", label: "reschedule_pending", startAt: FAR_START });
    const event = (await world.db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, booking.id))).find((line) => line.toLabel === "reschedule_pending");
    expect(event).toMatchObject({ fromLabel: "confirmed", toLabel: "reschedule_pending", note: "The client asked the studio to move it: Any weekday afternoon next week" });

    const studio = (await world.db.select().from(emailOutbox).where(eq(emailOutbox.kind, "move_request_studio")))[0];
    expect(studio).toMatchObject({ toEmail: OWNER_EMAIL, replyTo: "jane@example.com", subject: `Jane Smith asks to move booking ${booked.ref}` });
    expect(studio.body).toContain("What they wrote:\nAny weekday afternoon next week");
    expect(studio.body).toContain(`${BASE_URL}/admin/appointments/${booked.ref}`);
    const [copy] = await world.emails("move_request_received");
    expect(copy).toMatchObject({ toEmail: "jane@example.com", subject: `We have your request to move booking ${booked.ref}` });

    // Asked once: the page says so, and the instant reschedule code stays beside it.
    const choices = (await getManageChoices(world.db, booked.ref, byToken(booked.manageToken), NOW))!;
    expect(choices.request).toEqual({ allowed: false, text: "You have asked the studio to move this booking. The studio will contact you to agree a new time." });
    expect(choices.reschedule.allowed).toBe(true);
    expect(await askStudioToMove(world.db, booked.ref, byToken(booked.manageToken), "Again", deps())).toMatchObject({ ok: false, code: "already_asked" });
    expect(await world.emails("move_request_studio")).toHaveLength(1);
  });

  it("is made by the signed-in client too, never by someone else, and needs a few words within the limit", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    expect(await askStudioToMove(world.db, booked.ref, byToken("someone-elses-link-0000"), "Tuesday", deps())).toMatchObject({ ok: false, code: "not_found" });
    expect(await askStudioToMove(world.db, booked.ref, { kind: "customer", email: "bob@example.com" }, "Tuesday", deps())).toMatchObject({ ok: false, code: "not_found" });
    expect(await askStudioToMove(world.db, booked.ref, { kind: "customer", email: "jane@example.com" }, "   ", deps())).toEqual({
      ok: false,
      code: "bad_message",
      message: "Say when would suit you, so that the studio can find a time.",
    });
    expect(await askStudioToMove(world.db, booked.ref, { kind: "customer", email: "jane@example.com" }, "x".repeat(MOVE_REQUEST_MAX + 1), deps())).toMatchObject({ code: "bad_message" });
    expect(await askStudioToMove(world.db, booked.ref, { kind: "customer", email: "Jane@Example.com" }, "Tuesday", deps())).toEqual({ ok: true });
  });

  it("is not for a booking that has started or ended", async () => {
    const started = expectOk(await world.book({ date: FAR }));
    expect(await askStudioToMove(world.db, started.ref, byToken(started.manageToken), "Later", deps(FAR_START))).toMatchObject({ ok: false, code: "already_started" });
    expect((await getManageChoices(world.db, started.ref, byToken(started.manageToken), FAR_START))!.request).toEqual({ allowed: false, text: "" });
    const cancelled = expectOk(await world.book({ date: FAR, startMinute: h(14) }));
    expectOk(await cancelBooking(world.db, cancelled.ref, byToken(cancelled.manageToken), world.manageDeps()));
    expect(await askStudioToMove(world.db, cancelled.ref, byToken(cancelled.manageToken), "Later", deps())).toMatchObject({ ok: false, code: "not_confirmed" });
  });

  it("emails only the client when no studio address is set up, and the studio's move then takes the label off", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    expectOk(await askStudioToMove(world.db, booked.ref, byToken(booked.manageToken), "Saturday morning", deps(NOW, null)));
    expect(await world.emails("move_request_studio")).toHaveLength(0);
    expect(await world.emails("move_request_received")).toHaveLength(1);
    // The studio moves it at the client's request: Rescheduled, and it counts as their move.
    expectOk(await moveBooking(world.db, owner, booked.ref, { date: "2026-12-12", startMinute: h(10), countsAsClientMove: true }, hoursAfter(NOW, 1)));
    expect(await row(booked.ref)).toMatchObject({ label: "rescheduled", rescheduledCount: 1 });
  });
});
