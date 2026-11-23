import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bookings, studioHolds, waitlistEntries } from "@/db/schema";
import { loadCatalog } from "./catalog";
import { createTestWorld, daysAfter, expectOk, NEAR, NOW, type TestWorld } from "./testing";
import { joinWaitlist, listWaitlist, noticeWaitlist, removeFromWaitlist, type WaitlistInput } from "./waitlist";

const h = (hours: number) => hours * 60;

describe("Join Waitlist (the owner's brief of 2026-11-22, item 4)", () => {
  let world: TestWorld;
  beforeAll(async () => {
    world = await createTestWorld();
  });
  afterAll(() => world.close());
  beforeEach(() => world.reset());

  const place = (overrides: Partial<WaitlistInput>): WaitlistInput => ({
    studioIds: [world.ids.paris],
    photography: false,
    durationMinutes: 120,
    date: NEAR,
    fromMinute: h(10),
    toMinute: h(12),
    firstName: "Wren",
    lastName: "Waiting",
    email: "Wren@Example.com",
    ...overrides,
  });
  const join = async (overrides: Partial<WaitlistInput> = {}) => joinWaitlist(world.db, await loadCatalog(world.db), place(overrides), NOW);
  const notice = async (now = NOW) => noticeWaitlist(world.db, await loadCatalog(world.db), { now, baseUrl: "https://studio.test" });

  /** Paris from 10 to 12 on NEAR, then cancelled: the time is free again. */
  async function bookThenCancel() {
    const booked = expectOk(await world.book({ studioIds: [world.ids.paris], startMinute: h(10), durationMinutes: 120 }));
    return async () => {
      const [row] = await world.db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.ref, booked.ref)).returning({ id: bookings.id });
      await world.db.update(studioHolds).set({ active: false }).where(eq(studioHolds.bookingId, row.id));
    };
  }

  it("waits for a time that is taken, and emails the client once when it frees up, with a link to book it", async () => {
    const cancel = await bookThenCancel();
    const joined = expectOk(await join());
    expect(await notice()).toBe(0); // still taken
    await cancel();
    expect(await notice()).toBe(1);
    expect(await notice()).toBe(0); // once only
    const [mail] = await world.emails("waitlist_opening");
    expect(mail.toEmail).toBe("wren@example.com");
    expect(mail.subject).toBe("A time has opened up on Wednesday, November 18, 2026");
    expect(mail.body).toContain("Hi Wren,");
    expect(mail.body).toContain("Studio Paris, 2 hours, on Wednesday, November 18, 2026 between 10:00 AM and 12:00 PM");
    expect(mail.body).toContain(`https://studio.test/book?studio=paris&date=${NEAR}&duration=120`);
    expect(mail.body).toContain("It is not held for you: the first to book it has it.");
    const [listed] = await listWaitlist(world.db, await loadCatalog(world.db), "2026-11-14");
    expect(listed).toMatchObject({ id: joined.id, what: "Studio Paris", duration: "2 hours", timeRange: "10:00 AM – 12:00 PM", name: "Wren Waiting", email: "wren@example.com" });
    expect(listed.notifiedAt).not.toBeNull();
  });

  it("says a time that fits is free now, instead of waiting for it", async () => {
    const free = await join({ fromMinute: h(13), toMinute: h(17) });
    expect(free).toMatchObject({ ok: false, code: "free_now" });
    expect(!free.ok && free.starts?.[0]).toBe(h(13));
    expect(!free.ok && free.starts?.at(-1)).toBe(h(15)); // two hours, ending by 5 PM
    expect(!free.ok && free.message).toMatch(/^A time that fits is free now: 1:00 PM, .* Book it on this page\.$/);
  });

  it("is not emailed once removed, and forgets a place a month after its day", async () => {
    const cancel = await bookThenCancel();
    const joined = expectOk(await join());
    expect(await removeFromWaitlist(world.db, joined.id, "owner@studio.test", NOW)).toBe(true);
    await cancel();
    expect(await notice()).toBe(0);
    expect(await world.db.select().from(waitlistEntries)).toHaveLength(1);
    await notice(daysAfter(NOW, 40)); // NEAR is 4 days after NOW: 36 days past
    expect(await world.db.select().from(waitlistEntries)).toHaveLength(0);
  });

  it("refuses what it cannot wait for", async () => {
    await bookThenCancel();
    const refusal = async (overrides: Partial<WaitlistInput>) => {
      const result = await join(overrides);
      return result.ok ? null : result.message;
    };
    expect(await refusal({ studioIds: [world.ids.blanche, world.ids.dayglow] })).toBe("To book Blanche and Dayglow together, add Paris or choose a different combination.");
    expect(await refusal({ date: "2026-11-01" })).toBe("Choose a day from today on.");
    expect(await refusal({ durationMinutes: 45 })).toBe("That length is not offered on that day.");
    expect(await refusal({ fromMinute: h(12), toMinute: h(10) })).toBe("The end of the time range must be after its start.");
    expect(await refusal({ fromMinute: h(10), toMinute: h(11) })).toBe("The time range must be at least 2 hours long.");
    expect(await refusal({ firstName: " " })).toBe("Please enter your first and last name.");
    expect(await refusal({ email: "not an address" })).toBe("Please enter a valid email address.");
    // Five places at once per address.
    for (let i = 0; i < 5; i++) expectOk(await join());
    expect(await join()).toMatchObject({ ok: false, code: "too_many" });
  });
});
