import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookings, settings } from "@/db/schema";
import { customerStatus, filterPast, loadAppointments, parsePastFilter, studiosOf } from "./account";
import { moveBooking, setLabel } from "./appointments";
import type { AuthUser } from "./auth";
import { cancelBooking, requestRescheduleCode } from "./manage";
import { completeVisits } from "./tasks";
import { BASE_URL, createTestWorld, expectOk, FAR, h, hoursAfter, NEAR, NOW, type TestWorld } from "./testing";

/**
 * The owner's client portal, "My Appointments": what is still to come and
 * what is past, the past narrowed by date, studio and status, and "preserve
 * the original booking history when an appointment is rescheduled".
 */
let world: TestWorld;
let owner: AuthUser;

beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser("owner@studio.test", "owner", "Olivia");
});

const JANE = "jane@example.com";
const byToken = (token: string) => ({ kind: "token", token }) as const;
const AFTER_NEAR = new Date("2026-11-19T03:00:00Z"); // NEAR at 10 pm: its visits are over
const appointments = (now = NOW, email = JANE) => loadAppointments(world.db, email, now);

describe("a customer's appointments", () => {
  it("are split into what is still to come, soonest first, and everything else, newest first", async () => {
    const later = expectOk(await world.book({ date: FAR }));
    const sooner = expectOk(await world.book({ date: NEAR }));
    const cancelled = expectOk(await world.book({ date: FAR, studioIds: [world.ids.paris], durationMinutes: 60 }));
    expectOk(await cancelBooking(world.db, cancelled.ref, byToken(cancelled.manageToken), world.manageDeps()));

    const now = await appointments();
    expect(now.upcoming.map((booking) => booking.ref)).toEqual([sooner.ref, later.ref]);
    expect(now.past.map((booking) => booking.ref)).toEqual([cancelled.ref]);

    // Once a visit is over it is past, also before the scheduled task has marked it completed.
    const afterwards = await appointments(AFTER_NEAR);
    expect(afterwards.upcoming.map((booking) => booking.ref)).toEqual([later.ref]);
    expect(afterwards.past.map((booking) => booking.ref)).toEqual([cancelled.ref, sooner.ref]);
  });

  it("are the customer's own: found by the email address they signed in with, and nobody else's", async () => {
    expectOk(await world.book());
    expectOk(await world.book({ date: FAR, customer: { name: "Bob Brown", email: "bob@example.com", phone: "407-555-0111" } }));
    expect((await appointments()).upcoming).toHaveLength(1);
    expect((await appointments(NOW, " JANE@example.com ")).upcoming).toHaveLength(1);
    expect((await appointments(NOW, "bob@example.com")).upcoming.map((booking) => booking.customerName)).toEqual(["Bob Brown"]);
    expect(await appointments(NOW, "nobody@example.com")).toEqual({ upcoming: [], past: [] });
  });

  it("leave out a checkout that was abandoned or whose card was refused", async () => {
    expect(await world.book({ paymentToken: "mock-card-declined" })).toMatchObject({ ok: false });
    expect(await appointments()).toEqual({ upcoming: [], past: [] });
  });

  it("keep the record of a booking the studio moved: same reference, and the old and the new time", async () => {
    await world.db.insert(settings).values({ key: "staffMovesBookings", value: true });
    const booked = expectOk(await world.book({ date: NEAR }));
    expectOk(await moveBooking(world.db, owner, booked.ref, { date: "2026-11-19", startMinute: h(14), countsAsClientMove: true }, NOW));
    const { upcoming } = await appointments();
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]).toMatchObject({ ref: booked.ref, startAt: "2026-11-19T19:00:00.000Z", label: "rescheduled" });
    expect(upcoming[0].moves).toEqual(["Moved from Wed, Nov 18, 2026, 10:00 AM to Thu, Nov 19, 2026, 2:00 PM"]);
    expect(customerStatus(upcoming[0])).toEqual({ text: "Rescheduled", badge: "rescheduled" });
  });

  it("keep a booking the customer released for a reschedule code, beside the new one", async () => {
    const first = expectOk(await world.book({ date: FAR }));
    const credit = expectOk(await requestRescheduleCode(world.db, first.ref, byToken(first.manageToken), world.manageDeps()));
    const second = expectOk(await world.book({ date: "2026-12-10", promoCode: credit.code, paymentToken: undefined }));
    const { upcoming, past } = await appointments();
    expect(upcoming.map((booking) => booking.ref)).toEqual([second.ref]);
    expect(past.map((booking) => booking.ref)).toEqual([first.ref]);
    expect(customerStatus(past[0])).toEqual({ text: "Released for rescheduling", badge: "rescheduled" });
    expect(past[0]).toMatchObject({ totalCents: 17600, startAt: "2026-12-09T15:00:00.000Z" }); // as it was booked
  });
});

describe("the words for a status", () => {
  it("are the customer's: Confirmed, Checked In, Reschedule Pending, Completed, Missed, Cancelled", async () => {
    const booked = expectOk(await world.book());
    const during = hoursAfter(new Date("2026-11-18T15:00:00Z"), 0.5);
    const status = async (now = NOW) => {
      const { upcoming, past } = await appointments(now);
      return customerStatus([...upcoming, ...past][0]).text;
    };
    expect(await status()).toBe("Confirmed");
    expectOk(await setLabel(world.db, owner, booked.ref, "reschedule_pending", NOW));
    expect(await status()).toBe("Reschedule Pending");
    expectOk(await setLabel(world.db, owner, booked.ref, "checked_in", during));
    expect(await status(during)).toBe("Checked In");
    expectOk(await setLabel(world.db, owner, booked.ref, "no_show", during));
    expect(await status(during)).toBe("Missed");
    expectOk(await setLabel(world.db, owner, booked.ref, "completed", during));
    expect(await status(during)).toBe("Completed");
    await world.db.update(bookings).set({ status: "cancelled", cancelReason: "owner" }).where(eq(bookings.ref, booked.ref));
    expect(await status(during)).toBe("Cancelled");
  });
});

describe("narrowing the past", () => {
  /** Four past bookings: completed in Blanche, cancelled in Paris, missed in Dayglow, and one released for rescheduling. */
  async function history() {
    const completed = expectOk(await world.book({ date: NEAR }));
    const missed = expectOk(await world.book({ date: "2026-11-19", studioIds: [world.ids.dayglow], durationMinutes: 60 }));
    const cancelled = expectOk(await world.book({ date: FAR, studioIds: [world.ids.paris], durationMinutes: 60 }));
    const moved = expectOk(await world.book({ date: "2026-12-10", studioIds: [world.ids.blanche, world.ids.paris], durationMinutes: 60 }));
    expectOk(await cancelBooking(world.db, cancelled.ref, byToken(cancelled.manageToken), world.manageDeps()));
    expectOk(await requestRescheduleCode(world.db, moved.ref, byToken(moved.manageToken), world.manageDeps()));
    await setLabel(world.db, owner, missed.ref, "no_show", new Date("2026-11-19T16:00:00Z"));
    await completeVisits(world.db, new Date("2026-11-20T03:00:00Z"), BASE_URL);
    const { past } = await appointments(new Date("2026-11-20T04:00:00Z"));
    return { past, completed, missed, cancelled, moved };
  }

  it("by status", async () => {
    const { past, completed, missed, cancelled, moved } = await history();
    expect(past).toHaveLength(4);
    const refs = (filter: Parameters<typeof filterPast>[1]) => filterPast(past, filter).map((booking) => booking.ref);
    expect(refs({ status: "completed" })).toEqual([completed.ref]);
    expect(refs({ status: "missed" })).toEqual([missed.ref]);
    expect(refs({ status: "cancelled" })).toEqual([cancelled.ref]);
    expect(refs({ status: "rescheduled" })).toEqual([moved.ref]);
    expect(refs({})).toHaveLength(4);
  });

  it("by studio and by date, on the studio's calendar, and by all of them together", async () => {
    const { past, completed, missed, cancelled, moved } = await history();
    const refs = (filter: Parameters<typeof filterPast>[1]) => filterPast(past, filter).map((booking) => booking.ref);
    expect(studiosOf(past)).toEqual(["Studio Blanche", "Studio Dayglow", "Studio Paris"]);
    // A booking of two studios is found under each of them.
    expect(refs({ studio: "Studio Paris" })).toEqual([moved.ref, cancelled.ref]);
    expect(refs({ studio: "Studio Dayglow" })).toEqual([missed.ref]);
    expect(refs({ from: "2026-11-19", to: "2026-12-09" })).toEqual([cancelled.ref, missed.ref]);
    expect(refs({ to: "2026-11-18" })).toEqual([completed.ref]);
    expect(refs({ from: "2026-12-10" })).toEqual([moved.ref]);
    expect(refs({ studio: "Studio Blanche", status: "completed", from: "2026-11-18", to: "2026-11-18" })).toEqual([completed.ref]);
    expect(refs({ studio: "Studio Blanche", status: "missed" })).toEqual([]);
  });

  it("reads a filter from the page's address, and ignores what it does not understand", () => {
    expect(parsePastFilter({ from: "2026-11-01", to: "2026-11-30", studio: "Studio Paris", status: "completed", tab: "past" })).toEqual({
      from: "2026-11-01",
      to: "2026-11-30",
      studio: "Studio Paris",
      status: "completed",
    });
    expect(parsePastFilter({ from: "2026-02-30", to: "yesterday", status: "paid", studio: "" })).toEqual({});
    expect(parsePastFilter({ from: ["2026-11-01", "2026-11-02"], status: ["completed"] })).toEqual({});
    expect(parsePastFilter({})).toEqual({});
  });
});
