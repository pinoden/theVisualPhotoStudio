// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultDayType, isoWeekday } from "@/lib/domain/time";
import { NO_FACTS } from "@/lib/studio-facts";
import type { Catalog } from "@/server/catalog";
import { DEFAULT_SETTINGS } from "@/server/settings";
import { BookingFlow } from "./BookingFlow";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, refresh: nav.refresh }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

const B = "id-blanche";
const D = "id-dayglow";
const P = "id-paris";
const WED = "2030-01-09";
const SAT = "2030-01-12";
const h = (hours: number) => hours * 60;

const hours = Object.fromEntries(
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => [
    weekday,
    weekday <= 5 ? { openMinute: h(9), closeMinute: h(19) } : { openMinute: h(8), closeMinute: h(20) },
  ]),
);

function rulesFor(studioId: string, weekday: Record<number, number>, weekend: Record<number, number> = weekday) {
  return (["weekday", "weekend"] as const).flatMap((dayType) =>
    Object.entries(dayType === "weekday" ? weekday : weekend).map(([minutes, dollars]) => ({
      studioId,
      dayType,
      durationMinutes: Number(minutes),
      priceCents: dollars * 100,
    })),
  );
}

const catalog: Catalog = {
  studios: [
    { id: B, slug: "blanche", name: "Studio Blanche", tagline: "All white.", description: "", includedGuests: 6, extraGuests: 6, bufferMinutes: 10, color: "#4f7cac", hours, photos: [], facts: NO_FACTS, floorPlan: null },
    { id: D, slug: "dayglow", name: "Studio Dayglow", tagline: "Boho.", description: "", includedGuests: 6, extraGuests: 6, bufferMinutes: 10, color: "#c9851a", hours, photos: [], facts: NO_FACTS, floorPlan: null },
    { id: P, slug: "paris", name: "Studio Paris", tagline: "Vintage.", description: "", includedGuests: 4, extraGuests: 4, bufferMinutes: 10, color: "#b4517b", hours, photos: [], facts: NO_FACTS, floorPlan: null },
  ],
  rules: [
    ...rulesFor(B, { 60: 88, 120: 176, 600: 720 }, { 60: 110, 120: 200, 600: 800 }),
    ...rulesFor(D, { 60: 78, 120: 156 }),
    ...rulesFor(P, { 60: 68, 120: 136 }),
  ],
  addons: [
    { id: "addon-people", slug: "extra-guest", name: "Extra guest", description: "Beyond those included.", priceCents: 500, studioId: null, maxQuantity: 20, kind: "people" },
    { id: "addon-pet", slug: "pet-fee", name: "Pet fee", description: "Dayglow only.", priceCents: 4000, studioId: D, maxQuantity: 1, kind: "pet" },
  ],
  settings: { ...DEFAULT_SETTINGS, slotIncrementMinutes: 60, multiStudioPercent: { 2: 20, 3: 22 } },
  specialDates: {},
  photoPackages: [
    { id: "pack-b-60", studioId: B, durationMinutes: 60, priceCents: 37500, includes: "1–2 outfits, 20 edited images" },
    { id: "pack-b-120", studioId: B, durationMinutes: 120, priceCents: 57500, includes: "2–3 outfits, 30 edited images" },
    { id: "pack-p-60", studioId: P, durationMinutes: 60, priceCents: 31500, includes: "1–2 outfits, 20 edited images" },
  ],
  accessInfoSent: false,
  membershipPlans: [],
};

/** Taken time per studio that the fake server reports. */
let busy: Record<string, [number, number][]>;
let availabilityCalls: number;
/** What the fake server was last asked for, and when its photographer is taken. */
let availabilityAsked: string;
let photographerBusy: [number, number][];
let posted: Record<string, unknown>[];
let bookingReply: { status: number; body: Record<string, unknown> };
/** How many of the next answers to a booking are lost on the way, as when a phone's connection drops. */
let lostAnswers: number;

function reply(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

beforeEach(() => {
  busy = {};
  availabilityCalls = 0;
  availabilityAsked = "";
  photographerBusy = [];
  posted = [];
  lostAnswers = 0;
  bookingReply = { status: 201, body: { ok: true, ref: "VS-TEST22", manageToken: "secret-token-1234567890" } };
  nav.push.mockReset();
  nav.refresh.mockReset();
  nav.search = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: { body?: string }) => {
      if (input.startsWith("/api/availability")) {
        availabilityCalls++;
        availabilityAsked = input;
        const asked = new URL(input, "http://test").searchParams;
        const date = asked.get("date")!;
        const open = hours[isoWeekday(date)];
        return reply({
          date,
          dayType: defaultDayType(date),
          problem: null,
          earliestStartMinute: 0,
          ...(asked.get("photography") === "1"
            ? {
                photographer: {
                  studioId: "the-photographer",
                  openMinute: open.openMinute,
                  closeMinute: open.closeMinute,
                  bufferMinutes: 15,
                  busy: photographerBusy.map(([start, end]) => ({ start, end })),
                  anyStart: true,
                },
              }
            : {}),
          days: catalog.studios.map((s) => ({
            studioId: s.id,
            openMinute: open.openMinute,
            closeMinute: open.closeMinute,
            bufferMinutes: s.bufferMinutes,
            busy: (busy[s.id] ?? []).map(([start, end]) => ({ start, end })),
          })),
        });
      }
      if (input === "/api/booking-config") return reply({ mode: "mock" });
      // The server accepts any code as a free hour for the address that asks.
      if (input === "/api/quote") return reply({ ok: true, promo: { code: "THANKS-FREE-HOUR", kind: "free_hour", value: 60 } });
      if (input === "/api/bookings") {
        posted.push(JSON.parse(init!.body!));
        if (lostAnswers > 0) {
          lostAnswers--;
          throw new TypeError("Failed to fetch");
        }
        return reply(bookingReply.body, bookingReply.status);
      }
      throw new Error(`unexpected request: ${input}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const user = userEvent.setup();
const next = () => user.click(screen.getByRole("button", { name: /^Next/ }));
const studioBox = (name: string) => screen.getByRole("checkbox", { name: new RegExp(name) });
const pickDate = (value: string) => fireEvent.change(screen.getByLabelText("Date"), { target: { value } });
const pickDuration = (label: string) => user.click(screen.getByRole("button", { name: label }));
const pickTime = async (label: string) => user.click(await screen.findByRole("button", { name: new RegExp(`^${label}`) }));

async function fillDetails() {
  await user.type(screen.getByLabelText("Full name *"), "Jane Smith");
  await user.type(screen.getByLabelText("Email address *"), "jane@example.com");
  await user.type(screen.getByLabelText("Phone number *"), "407-555-0100");
  await user.click(screen.getByRole("checkbox", { name: /I have read and agree/ }));
}

describe("studio-first flow", () => {
  it("requires Paris with Blanche and Dayglow and books an allowed pair at the price shown", async () => {
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);

    await user.click(studioBox("Studio Blanche"));
    await user.click(studioBox("Studio Dayglow"));
    await next();
    expect(screen.getByRole("alert").textContent).toContain("add Paris or choose a different combination");
    await user.click(studioBox("Studio Dayglow"));
    await user.click(studioBox("Studio Paris"));
    await next();

    pickDate(WED);
    await pickDuration("1 hr");
    // ($88 + $68) less the 20% two-studio discount
    expect(screen.getByText("Estimated total").nextElementSibling?.textContent).toBe("$124.80");
    await next();

    await pickTime("10:00 AM");
    await next();

    await fillDetails();
    expect(screen.getByText("Wednesday, January 9, 2030, 10:00 AM – 11:00 AM")).toBeTruthy();
    await next();

    expect(await screen.findByText(/No card processor is connected/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Confirm & pay $124.80" }));

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/booking/VS-TEST22?t=secret-token-1234567890"));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      studioIds: [B, P],
      date: WED,
      startMinute: h(10),
      durationMinutes: 60,
      customer: { name: "Jane Smith", email: "jane@example.com", phone: "407-555-0100" },
      addons: [],
      acceptTerms: true,
      paymentToken: "mock-card-ok",
      expectedTotalCents: 12480,
    });
  });

  it("offers only times when every chosen studio is free", async () => {
    busy = { [B]: [[h(10), h(12) + 10]], [P]: [[h(15), h(16) + 10]] };
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    await user.click(studioBox("Studio Blanche"));
    await user.click(studioBox("Studio Paris"));
    await next();
    pickDate(WED);
    await pickDuration("1 hr");
    await next();

    await screen.findByRole("button", { name: "1:00 PM" });
    const offered = screen.getAllByRole("button").map((b) => b.textContent);
    for (const taken of ["9:00 AM", "10:00 AM", "11:00 AM", "12:00 PM", "2:00 PM", "3:00 PM", "4:00 PM"]) {
      expect(offered).not.toContain(taken);
    }
    expect(offered).toContain("1:00 PM");
    expect(offered).toContain("5:00 PM");
  });

  it("explains when the chosen studios are never free together that day", async () => {
    busy = { [B]: [[0, h(14)]], [P]: [[h(13), 1440]] };
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    await user.click(studioBox("Studio Blanche"));
    await user.click(studioBox("Studio Paris"));
    await next();
    pickDate(WED);
    await pickDuration("1 hr");
    await next();
    expect(await screen.findByText(/not free together on this date/)).toBeTruthy();
  });

  it("offers only durations every chosen studio has, and prices weekends separately", async () => {
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    await user.click(studioBox("Studio Blanche"));
    await next();
    expect(screen.getByRole("button", { name: "10 hr" })).toBeTruthy();

    pickDate(WED);
    await pickDuration("1 hr");
    expect(screen.getByText("Estimated total").nextElementSibling?.textContent).toBe("$88");
    pickDate(SAT);
    expect(screen.getByText("Estimated total").nextElementSibling?.textContent).toBe("$110");

    // Paris has no 10-hour price, so adding it removes that duration.
    await user.click(screen.getByRole("button", { name: /Back/ }));
    await user.click(studioBox("Studio Paris"));
    await next();
    expect(screen.queryByRole("button", { name: "10 hr" })).toBeNull();
  });

  it("keeps working while a date is typed digit by digit, and takes it once it is a real date", async () => {
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    await user.click(studioBox("Studio Paris"));
    await next();
    // What a browser's date field holds as the year 2030 is typed into it, one digit at a time.
    for (const typing of ["0002-01-09", "0020-01-09", "0203-01-09", WED]) pickDate(typing);
    await pickDuration("1 hr");
    expect(screen.getByText("Estimated total").nextElementSibling?.textContent).toBe("$68");
    // A date that is not one yet is no date: the step asks for one.
    pickDate("0002-01-09");
    await next();
    expect(screen.getByRole("alert").textContent).toBe("Please select a date.");
  });

  it("does not let the customer skip a step", async () => {
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    await next();
    expect(screen.getByRole("alert").textContent).toBe("Please select at least one studio.");
    await user.click(studioBox("Studio Paris"));
    await next();
    await next();
    expect(screen.getByRole("alert").textContent).toBe("Please select a date.");
    pickDate(WED);
    await next();
    expect(screen.getByRole("alert").textContent).toBe("Please select a duration.");
    await pickDuration("2 hr");
    await next();
    await screen.findByRole("button", { name: "9:00 AM" });
    await next();
    expect(screen.getByRole("alert").textContent).toBe("Please select a time.");
    await pickTime("9:00 AM");
    await next();
    await next();
    expect(screen.getByRole("alert").textContent).toBe("Please enter your name.");
    await fillDetails();
    await user.click(screen.getByRole("checkbox", { name: /I have read and agree/ })); // untick
    await next();
    expect(screen.getByRole("alert").textContent).toBe("Please agree to the studio policies to continue.");
    expect(posted).toHaveLength(0);
  });

  it("preselects the studio named in the page address", async () => {
    nav.search = "studio=paris";
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    expect((studioBox("Studio Paris") as HTMLInputElement).checked).toBe(true);
    expect((studioBox("Studio Blanche") as HTMLInputElement).checked).toBe(false);
  });

  it("shows an add-on only when its studio is booked, and charges it", async () => {
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    await user.click(studioBox("Studio Dayglow"));
    await next();
    pickDate(WED);
    await pickDuration("1 hr");
    await next();
    await pickTime("9:00 AM");
    await next();
    await user.click(screen.getByRole("checkbox", { name: /Pet fee/ }));
    await fillDetails();
    await next();
    await user.click(await screen.findByRole("button", { name: "Confirm & pay $118" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ addons: [{ addonId: "addon-pet", quantity: 1 }], expectedTotalCents: 11800 });

    cleanup();
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    await user.click(studioBox("Studio Blanche"));
    await next();
    pickDate(WED);
    await pickDuration("1 hr");
    await next();
    await pickTime("9:00 AM");
    await next();
    expect(screen.queryByRole("checkbox", { name: /Pet fee/ })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Extra guest" })).toBeTruthy();
  });

  it("takes extra guests in a number, up to what the studio allows, at $5 each", async () => {
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    await user.click(studioBox("Studio Paris"));
    await next();
    pickDate(WED);
    await pickDuration("1 hr");
    await next();
    await pickTime("9:00 AM");
    await next();
    const guests = screen.getByRole("combobox", { name: "Extra guest" }) as HTMLSelectElement;
    // Paris takes 4 extra guests.
    expect([...guests.options].map((option) => option.value)).toEqual(["0", "1", "2", "3", "4"]);
    expect(screen.getByText("Up to 4 extra guests with this studio.")).toBeTruthy();
    await user.selectOptions(guests, "3");
    expect(screen.getByText("Extra guest × 3")).toBeTruthy();
    await fillDetails();
    await next();
    await user.click(await screen.findByRole("button", { name: "Confirm & pay $83" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ addons: [{ addonId: "addon-people", quantity: 3 }], expectedTotalCents: 8300 });
  });

  it("returns to the time step with fresh availability when the slot was just taken", async () => {
    bookingReply = { status: 409, body: { ok: false, code: "slot_taken", message: "That time was just taken. Please choose another." } };
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    await user.click(studioBox("Studio Paris"));
    await next();
    pickDate(WED);
    await pickDuration("1 hr");
    await next();
    await pickTime("9:00 AM");
    await next();
    await fillDetails();
    await next();
    expect(availabilityCalls).toBe(1);
    busy = { [P]: [[h(9), h(10) + 10]] };
    await user.click(await screen.findByRole("button", { name: "Confirm & pay $68" }));

    expect((await screen.findByRole("alert")).textContent).toBe("That time was just taken. Please choose another.");
    await screen.findByRole("button", { name: "11:00 AM" });
    expect(availabilityCalls).toBe(2);
    expect(screen.queryByRole("button", { name: "9:00 AM" })).toBeNull();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("reloads prices when the server says the price changed", async () => {
    bookingReply = { status: 409, body: { ok: false, code: "price_changed", message: "The price is now $75. Please review and confirm again." } };
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    await user.click(studioBox("Studio Paris"));
    await next();
    pickDate(WED);
    await pickDuration("1 hr");
    await next();
    await pickTime("9:00 AM");
    await next();
    await fillDetails();
    await next();
    await user.click(await screen.findByRole("button", { name: "Confirm & pay $68" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The price is now $75");
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("reloads what is offered when an add-on was withdrawn while the customer was checking out", async () => {
    bookingReply = { status: 422, body: { ok: false, code: "invalid_price", message: "An add-on you chose is no longer offered." } };
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    await user.click(studioBox("Studio Paris"));
    await next();
    pickDate(WED);
    await pickDuration("1 hr");
    await next();
    await pickTime("9:00 AM");
    await next();
    await fillDetails();
    await next();
    await user.click(await screen.findByRole("button", { name: "Confirm & pay $68" }));
    const alert = (await screen.findByRole("alert")).textContent;
    expect(alert).toContain("An add-on you chose is no longer offered.");
    expect(alert).toContain("please review your booking and confirm again");
    expect(nav.refresh).toHaveBeenCalledTimes(1); // the page is given the current add-ons and prices
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("states the discount for several studios as it is charged, not more", () => {
    const settings = { ...catalog.settings, multiStudioPercent: { 2: 15, 3: 0 } };
    render(<BookingFlow catalog={{ ...catalog, settings }} navigate={nav.push} />);
    expect(screen.getByText(/Paris is included in every bundle/).textContent).toBe(
      "Paris is included in every bundle. 15% off when you book exactly 2.",
    );
  });

  it("takes a free hour off one studio, and sets it aside with the reason when a second studio is added", async () => {
    const back = () => user.click(screen.getByRole("button", { name: /Back/ }));
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    await user.click(studioBox("Studio Paris"));
    await next();
    pickDate(WED);
    await pickDuration("1 hr");
    await next();
    await pickTime("9:00 AM");
    await next();
    await fillDetails();
    await user.type(screen.getByLabelText("Have a code?"), "thanks-free-hour");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    // Studio Paris for an hour is $68, and the hour is free.
    expect(await screen.findByText("Free hour, code THANKS-FREE-HOUR")).toBeTruthy();
    expect(screen.getByText("To pay").nextElementSibling?.textContent).toBe("$0");

    // Back to the studios, to add a second one: the free hour is for one studio only.
    await back();
    await back();
    await back();
    await user.click(studioBox("Studio Blanche"));
    await next();
    await next();
    await pickTime("9:00 AM");
    await next();
    expect(screen.getByRole("status").textContent).toBe(
      "A free hour is for one studio. It cannot be used when several studios are booked together. Code THANKS-FREE-HOUR is not used on this booking and stays yours.",
    );
    expect(screen.queryByText("Free hour, code THANKS-FREE-HOUR")).toBeNull();
    // ($88 + $68) less the 20% two-studio discount, with nothing taken off for the code.
    expect(screen.getByText("To pay").nextElementSibling?.textContent).toBe("$124.80");

    await next();
    await user.click(await screen.findByRole("button", { name: "Confirm & pay $124.80" }));
    expect(posted[0]).toMatchObject({ expectedTotalCents: 12480 });
    expect(posted[0].promoCode).toBeUndefined(); // the code is not sent, so it is not spent
  });

  it("is usable from the keyboard: each new step takes the focus to its heading, and Enter applies a code", async () => {
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    // Nothing takes the focus as the page opens.
    expect(document.activeElement).toBe(document.body);
    await user.click(studioBox("Studio Paris"));
    await next();
    // The button that was pressed is gone with its step: the focus is on the new step's heading, not lost.
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Select date & duration" }));
    pickDate(WED);
    await pickDuration("1 hr");
    await next();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Choose a time" }));
    await pickTime("9:00 AM");
    await next();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Your details" }));
    await user.click(screen.getByRole("button", { name: /Back/ }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Choose a time" }));
    await next();

    await fillDetails();
    await user.type(screen.getByLabelText("Have a code?"), "thanks-free-hour{Enter}");
    expect(await screen.findByText("Free hour, code THANKS-FREE-HOUR")).toBeTruthy();
    // Enter checked the code and did nothing else: the customer is still on their details.
    expect(screen.getByRole("heading", { name: "Your details" })).toBeTruthy();
    expect(posted).toHaveLength(0);
  });

  it("sends the same attempt again after no answer at all, so a booking that was made is found", async () => {
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    await user.click(studioBox("Studio Paris"));
    await next();
    pickDate(WED);
    await pickDuration("1 hr");
    await next();
    await pickTime("9:00 AM");
    await next();
    await fillDetails();
    await next();
    // The booking is made, and its answer is lost on the way.
    lostAnswers = 1;
    await user.click(await screen.findByRole("button", { name: "Confirm & pay $68" }));
    expect((await screen.findByRole("alert")).textContent).toContain("we cannot tell whether your booking went through");
    expect(nav.push).not.toHaveBeenCalled();
    // Pressed again, the same attempt: the server finds the booking, and the customer is taken to it.
    await user.click(screen.getByRole("button", { name: "Confirm & pay $68" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/booking/VS-TEST22?t=secret-token-1234567890"));
    expect(posted).toHaveLength(2);
    expect(posted[0].requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(posted[1].requestId).toBe(posted[0].requestId);
  });

  it("starts a new attempt after an answer, and after a step back", async () => {
    bookingReply = { status: 402, body: { ok: false, code: "payment_failed", message: "Payment failed: Card declined. Your card was not charged." } };
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    await user.click(studioBox("Studio Paris"));
    await next();
    pickDate(WED);
    await pickDuration("1 hr");
    await next();
    await pickTime("9:00 AM");
    await next();
    await fillDetails();
    await next();
    await user.click(await screen.findByRole("button", { name: "Confirm & pay $68" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Card declined");
    await user.click(screen.getByRole("button", { name: "Confirm & pay $68" }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1].requestId).not.toBe(posted[0].requestId);
    // No answer, then a step back and forward again: a new attempt too.
    lostAnswers = 1;
    await user.click(screen.getByRole("button", { name: "Confirm & pay $68" }));
    await waitFor(() => expect(posted).toHaveLength(3));
    await user.click(screen.getByRole("button", { name: /Back/ }));
    await next();
    await user.click(await screen.findByRole("button", { name: "Confirm & pay $68" }));
    await waitFor(() => expect(posted).toHaveLength(4));
    expect(posted[3].requestId).not.toBe(posted[2].requestId);
  });

  it("shows the server's message when payment fails and stays on the payment step", async () => {
    bookingReply = { status: 402, body: { ok: false, code: "payment_failed", message: "Payment failed: Card declined. Your card was not charged." } };
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    await user.click(studioBox("Studio Paris"));
    await next();
    pickDate(WED);
    await pickDuration("1 hr");
    await next();
    await pickTime("9:00 AM");
    await next();
    await fillDetails();
    await next();
    await user.click(await screen.findByRole("button", { name: "Confirm & pay $68" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Card declined");
    expect(screen.getByRole("button", { name: "Confirm & pay $68" })).toBeTruthy();
    expect(nav.push).not.toHaveBeenCalled();
  });
});

describe("time-first flow", () => {
  it("allows Blanche and Dayglow together once Paris is added", async () => {
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    await user.click(screen.getByRole("radio", { name: /I know when I want to come/ }));
    pickDate(WED);
    await pickDuration("1 hr");
    await next();
    await pickTime("10:00 AM");
    await next();

    await user.click(studioBox("Studio Blanche"));
    await user.click(studioBox("Studio Dayglow"));
    await next();
    expect(screen.getByRole("alert").textContent).toContain("add Paris or choose a different combination");
    await user.click(studioBox("Studio Paris"));
    await next();
    expect(screen.getByLabelText("Full name *")).toBeTruthy();
  });

  it("shows which studios are free at the chosen time and books from there", async () => {
    busy = { [B]: [[h(10), h(12) + 10]] };
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    await user.click(screen.getByRole("radio", { name: /I know when I want to come/ }));

    // The first step is now the date, not the studio.
    pickDate(WED);
    await pickDuration("2 hr");
    await next();

    const nine = await screen.findByRole("button", { name: /^9:00 AM/ });
    expect(nine.textContent).toBe("9:00 AM2 studios free"); // Blanche could not be cleaned before its 10:00 booking
    expect(screen.getByRole("button", { name: /^10:00 AM/ }).textContent).toBe("10:00 AM2 studios free");
    expect(screen.getByRole("button", { name: /^1:00 PM/ }).textContent).toBe("1:00 PM3 studios free");
    await pickTime("10:00 AM");
    await next();

    const blanche = studioBox("Studio Blanche") as HTMLInputElement;
    expect(blanche.disabled).toBe(true);
    expect(within(blanche.closest("label")!).getByText("Not available at this time")).toBeTruthy();
    expect(within(studioBox("Studio Paris").closest("label")!).getByText("$136 for 2 hours")).toBeTruthy();
    expect((studioBox("Studio Dayglow") as HTMLInputElement).disabled).toBe(false);

    await user.click(studioBox("Studio Paris"));
    await user.click(studioBox("Studio Dayglow"));
    await next();
    await fillDetails();
    await next();
    await user.click(await screen.findByRole("button", { name: "Confirm & pay $233.60" })); // ($156 + $136) less 20%

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      studioIds: [D, P],
      date: WED,
      startMinute: h(10),
      durationMinutes: 120,
      expectedTotalCents: 23360,
    });
  });

  it("lists a time only if some studio is free then", async () => {
    busy = { [B]: [[0, 1440]], [D]: [[0, 1440]], [P]: [[h(9), h(15)]] };
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    await user.click(screen.getByRole("radio", { name: /I know when I want to come/ }));
    pickDate(WED);
    await pickDuration("1 hr");
    await next();
    await screen.findByRole("button", { name: /^3:00 PM/ });
    const times = screen.getAllByRole("button").map((b) => b.textContent).filter((t) => /studio/.test(t ?? ""));
    expect(times).toEqual(["3:00 PM1 studio free", "4:00 PM1 studio free", "5:00 PM1 studio free", "6:00 PM1 studio free"]);
  });

  it("counts only studios that offer the chosen duration", async () => {
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    await user.click(screen.getByRole("radio", { name: /I know when I want to come/ }));
    pickDate(WED);
    await pickDuration("10 hr"); // only Blanche has a 10-hour price
    await next();
    expect((await screen.findByRole("button", { name: /^9:00 AM/ })).textContent).toBe("9:00 AM1 studio free");
    await pickTime("9:00 AM");
    await next();
    expect((studioBox("Studio Blanche") as HTMLInputElement).disabled).toBe(false);
    expect((studioBox("Studio Paris") as HTMLInputElement).disabled).toBe(true);
  });

  it("forgets the studio choice when the customer goes back and changes the time", async () => {
    busy = { [P]: [[h(14), h(15) + 10]] };
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    await user.click(screen.getByRole("radio", { name: /I know when I want to come/ }));
    pickDate(WED);
    await pickDuration("1 hr");
    await next();
    await pickTime("9:00 AM");
    await next();
    await user.click(studioBox("Studio Paris"));
    await user.click(screen.getByRole("button", { name: /Back/ }));
    await pickTime("2:00 PM"); // Paris is taken at 2:00 PM
    await next();
    expect((studioBox("Studio Paris") as HTMLInputElement).checked).toBe(false);
    expect((studioBox("Studio Paris") as HTMLInputElement).disabled).toBe(true);
    await next();
    expect(screen.getByRole("alert").textContent).toBe("Please select at least one studio.");
  });
});

describe("switching between the two flows", () => {
  it("starts over from the first step of the other flow", async () => {
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    await user.click(studioBox("Studio Paris"));
    await next();
    expect(screen.getByLabelText("Date")).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: /I know when I want to come/ }));
    expect(screen.getByLabelText("Date")).toBeTruthy(); // date is the first step here
    expect(screen.queryByRole("button", { name: /Back/ })).toBeNull();
    await user.click(screen.getByRole("radio", { name: /I know which studio I want/ }));
    expect(studioBox("Studio Paris")).toBeTruthy();
  });
});

describe("the photography flow", () => {
  it("books a session in one studio, at a time when the photographer is free too", async () => {
    photographerBusy = [[h(9), h(10) + 15]]; // at another session until 10:00, and 15 minutes after it
    render(<BookingFlow catalog={catalog} navigate={nav.push} photography />);

    // No choice between two ways of booking here, and one studio only: choosing another replaces the first.
    expect(screen.queryByRole("radiogroup")).toBeNull();
    const studio = (name: string) => screen.getByRole("radio", { name: new RegExp(name) }) as HTMLInputElement;
    await user.click(studio("Studio Blanche"));
    await user.click(studio("Studio Paris"));
    expect(studio("Studio Blanche").checked).toBe(false);
    expect(studio("Studio Paris").checked).toBe(true);
    expect(studio("Studio Dayglow").disabled).toBe(true); // no session is sold there
    expect(screen.getByText("Sessions from $315")).toBeTruthy();
    await next();

    // A session in place of a duration: its length, its price and what it includes.
    pickDate(WED);
    const oneHour = screen.getByRole("button", { name: /1 hour · \$315/ });
    expect(oneHour.textContent).toContain("Studio included. 1–2 outfits, 20 edited images.");
    expect(screen.queryByRole("button", { name: /2 hours/ })).toBeNull(); // not sold in Paris
    await user.click(oneHour);
    await next();

    // Paris is free all day. The photographer is not, until a quarter past ten.
    expect(availabilityAsked).toContain("photography=1");
    await screen.findByRole("button", { name: /^11:00 AM/ });
    expect(screen.queryByRole("button", { name: /^9:00 AM/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^10:00 AM/ })).toBeNull();
    await pickTime("11:00 AM");
    await next();

    await fillDetails();
    expect(screen.getByText(/Photography session, Studio Paris, 1 hour/)).toBeTruthy();
    expect(screen.getByText(/A photography session is refunded when it is cancelled 14 days or more before it starts/)).toBeTruthy();
    await next();
    await user.click(await screen.findByRole("button", { name: "Confirm & pay $315" }));

    expect(posted[0]).toMatchObject({
      photography: true,
      studioIds: [P],
      date: WED,
      startMinute: h(11),
      durationMinutes: 60,
      expectedTotalCents: 31500,
    });
    expect(nav.push).toHaveBeenCalledWith("/booking/VS-TEST22?t=secret-token-1234567890");
  });

  it("offers nothing when there is no photographer to book that day", async () => {
    photographerBusy = [[0, 24 * 60]];
    render(<BookingFlow catalog={catalog} navigate={nav.push} photography />);
    await user.click(screen.getByRole("radio", { name: /Studio Blanche/ }));
    await next();
    pickDate(WED);
    await user.click(screen.getByRole("button", { name: /2 hours · \$575/ }));
    await next();
    expect(await screen.findByText("No times are available on this date. Please try another day.")).toBeTruthy();
  });

  it("is not part of renting a studio: the studio flow asks for no photographer and sends none", async () => {
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    await user.click(studioBox("Studio Paris"));
    await next();
    pickDate(WED);
    await pickDuration("1 hr");
    await next();
    await pickTime("9:00 AM");
    expect(availabilityAsked).not.toContain("photography");
    await next();
    await fillDetails();
    await next();
    await user.click(await screen.findByRole("button", { name: "Confirm & pay $68" }));
    expect(posted[0]).toMatchObject({ photography: false, expectedTotalCents: 6800 });
  });
});
