import { describe, expect, it } from "vitest";
import { KEPT_HOURS, keptText, readKept, stepHash, stepOfHash, stepToShowAgain, type BookingStep, type KeptBooking } from "./booking-progress";

const STUDIO_FIRST: BookingStep[] = ["studios", "when", "details", "policies", "pay"];
const TIME_FIRST: BookingStep[] = ["when", "studios", "details", "policies", "pay"];
const NOW = Date.parse("2026-11-27T15:00:00Z");

const kept = (changes: Partial<KeptBooking> = {}): KeptBooking => ({
  at: NOW,
  mode: "studio",
  studioIds: ["paris"],
  date: "2026-12-09",
  duration: 120,
  start: 540,
  moreLengths: false,
  addonCounts: { guest: 2 },
  name: "Jane Smith",
  email: "jane@example.com",
  phone: "407-555-0100",
  notes: "Two outfits",
  answers: { q1: "A family shoot", q2: true },
  codeInput: "THANKS",
  applied: null,
  depth: 2,
  ...changes,
});

describe("a step's mark in the address", () => {
  it("names the step after #, and is read back as the step's place on the path the client is on", () => {
    expect(stepHash("details")).toBe("#step-details");
    expect(stepOfHash("#step-details", STUDIO_FIRST)).toBe(2);
    expect(stepOfHash("#step-studios", STUDIO_FIRST)).toBe(0);
    // The date-first path has the same steps in another order.
    expect(stepOfHash("#step-studios", TIME_FIRST)).toBe(1);
    expect(stepOfHash("#step-when", TIME_FIRST)).toBe(0);
  });

  it("is none for the page's own address, another mark of the page, and a step there is not", () => {
    for (const hash of ["", "#", "#main", "#step-", "#step-checkout", "#step-details-2", "step-details", "#STEP-DETAILS"]) {
      expect(stepOfHash(hash, STUDIO_FIRST), hash).toBe(-1);
    }
  });
});

describe("what the tab keeps of a booking in the making", () => {
  it("comes back as it was kept", () => {
    const booking = kept({ applied: { code: "THANKS", kind: "percent", value: 10, email: "jane@example.com" } });
    expect(readKept(keptText(booking), NOW + 60_000)).toEqual(booking);
  });

  it("is nothing for a screen nobody has touched, so that an empty screen is never made anew from it", () => {
    const untouched = kept({ studioIds: [], date: "", duration: 0, start: null, addonCounts: {}, name: " ", email: "", phone: "", notes: "", answers: {}, codeInput: "" });
    expect(keptText(untouched)).toBeNull();
    expect(readKept(JSON.stringify(untouched), NOW)).toBeNull();
    // One thing chosen is enough.
    expect(keptText({ ...untouched, studioIds: ["paris"] })).not.toBeNull();
    expect(keptText({ ...untouched, name: "J" })).not.toBeNull();
  });

  it("is not brought back once the booking was left for longer than half a day", () => {
    const text = keptText(kept());
    expect(readKept(text, NOW + (KEPT_HOURS - 1) * 3_600_000)).not.toBeNull();
    expect(readKept(text, NOW + (KEPT_HOURS + 1) * 3_600_000)).toBeNull();
    // Nor one that says it was kept in the future: the clock was changed, or the text was.
    expect(readKept(text, NOW - 3_600_000)).toBeNull();
  });

  it("is refused whole when any part of it is not what the screen writes", () => {
    const good = kept();
    const broken: unknown[] = [
      null,
      "",
      "not json",
      "[]",
      JSON.stringify("text"),
      JSON.stringify({ ...good, mode: "sideways" }),
      JSON.stringify({ ...good, studioIds: "paris" }),
      JSON.stringify({ ...good, studioIds: [1, 2] }),
      JSON.stringify({ ...good, date: "next week" }),
      JSON.stringify({ ...good, duration: -60 }),
      JSON.stringify({ ...good, start: 2000 }),
      JSON.stringify({ ...good, start: "9:00" }),
      JSON.stringify({ ...good, addonCounts: { guest: 0 } }),
      JSON.stringify({ ...good, addonCounts: { guest: "two" } }),
      JSON.stringify({ ...good, name: null }),
      JSON.stringify({ ...good, answers: { q1: 5 } }),
      JSON.stringify({ ...good, applied: { code: "X" } }),
      JSON.stringify({ ...good, depth: -1 }),
      JSON.stringify({ ...good, at: "today" }),
      JSON.stringify({ ...good, moreLengths: "yes" }),
    ];
    for (const raw of broken) expect(readKept(raw as string | null, NOW), String(raw)).toBeNull();
  });
});

describe("the step shown again after a refresh", () => {
  it("is the one the address marks, when every step before it is answered", () => {
    expect(stepToShowAgain(kept(), 2, STUDIO_FIRST)).toBe(2);
    expect(stepToShowAgain(kept(), 1, STUDIO_FIRST)).toBe(1);
    expect(stepToShowAgain(kept(), 0, STUDIO_FIRST)).toBe(0);
  });

  it("stops at the first step that what was kept does not answer", () => {
    expect(stepToShowAgain(kept({ studioIds: [] }), 3, STUDIO_FIRST)).toBe(0);
    expect(stepToShowAgain(kept({ start: null }), 3, STUDIO_FIRST)).toBe(1);
    expect(stepToShowAgain(kept({ date: "" }), 3, STUDIO_FIRST)).toBe(1);
    expect(stepToShowAgain(kept({ phone: "no phone" }), 4, STUDIO_FIRST)).toBe(2);
    expect(stepToShowAgain(kept({ email: "jane@" }), 4, STUDIO_FIRST)).toBe(2);
    // On the date-first path the day comes before the studios.
    expect(stepToShowAgain(kept({ mode: "time", studioIds: [] }), 3, TIME_FIRST)).toBe(1);
    expect(stepToShowAgain(kept({ mode: "time", start: null }), 3, TIME_FIRST)).toBe(0);
  });

  it("is never past the policies, which are agreed to again, and the first when nothing was kept", () => {
    expect(stepToShowAgain(kept(), 4, STUDIO_FIRST)).toBe(3);
    expect(stepToShowAgain(kept(), 3, STUDIO_FIRST)).toBe(3);
    expect(stepToShowAgain(null, 4, STUDIO_FIRST)).toBe(0);
  });
});
