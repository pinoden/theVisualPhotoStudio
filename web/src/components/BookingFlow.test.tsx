// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultDayType, isoWeekday } from "@/lib/domain/time";
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
    { id: B, slug: "blanche", name: "Studio Blanche", tagline: "All white.", description: "", includedGuests: 6, bufferMinutes: 10, color: "#4f7cac", hours },
    { id: D, slug: "dayglow", name: "Studio Dayglow", tagline: "Boho.", description: "", includedGuests: 6, bufferMinutes: 10, color: "#c9851a", hours },
    { id: P, slug: "paris", name: "Studio Paris", tagline: "Vintage.", description: "", includedGuests: 4, bufferMinutes: 10, color: "#b4517b", hours },
  ],
  rules: [
    ...rulesFor(B, { 60: 88, 120: 176, 600: 720 }, { 60: 110, 120: 200, 600: 800 }),
    ...rulesFor(D, { 60: 78, 120: 156 }),
    ...rulesFor(P, { 60: 68, 120: 136 }),
  ],
  addons: [
    { id: "addon-people", slug: "extra-people", name: "Extra people", description: "Bigger groups.", priceCents: 3000, studioId: null, maxQuantity: 1, kind: "people" },
    { id: "addon-pet", slug: "pet-fee", name: "Pet fee", description: "Dayglow only.", priceCents: 4000, studioId: D, maxQuantity: 1, kind: "pet" },
  ],
  settings: { ...DEFAULT_SETTINGS, slotIncrementMinutes: 60, multiStudioPercent: { 2: 20, 3: 22 } },
  specialDates: {},
  accessInfoSent: false,
};

/** Taken time per studio that the fake server reports. */
let busy: Record<string, [number, number][]>;
let availabilityCalls: number;
let posted: Record<string, unknown>[];
let bookingReply: { status: number; body: Record<string, unknown> };

function reply(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

beforeEach(() => {
  busy = {};
  availabilityCalls = 0;
  posted = [];
  bookingReply = { status: 201, body: { ok: true, ref: "VS-TEST22", manageToken: "secret-token-1234567890" } };
  nav.push.mockReset();
  nav.refresh.mockReset();
  nav.search = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: { body?: string }) => {
      if (input.startsWith("/api/availability")) {
        availabilityCalls++;
        const date = new URL(input, "http://test").searchParams.get("date")!;
        const open = hours[isoWeekday(date)];
        return reply({
          date,
          dayType: defaultDayType(date),
          problem: null,
          earliestStartMinute: 0,
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
  it("books any two studios together and sends what the customer saw", async () => {
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);

    await user.click(studioBox("Studio Blanche"));
    await user.click(studioBox("Studio Dayglow"));
    await next();

    pickDate(WED);
    await pickDuration("1 hr");
    // ($88 + $78) less the 20% two-studio discount
    expect(screen.getByText("Estimated total").nextElementSibling?.textContent).toBe("$132.80");
    await next();

    await pickTime("10:00 AM");
    await next();

    await fillDetails();
    expect(screen.getByText("Wednesday, January 9, 2030, 10:00 AM – 11:00 AM")).toBeTruthy();
    await next();

    expect(await screen.findByText(/No card processor is connected/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Confirm & pay $132.80" }));

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/booking/VS-TEST22?t=secret-token-1234567890"));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      studioIds: [B, D],
      date: WED,
      startMinute: h(10),
      durationMinutes: 60,
      customer: { name: "Jane Smith", email: "jane@example.com", phone: "407-555-0100" },
      addons: [],
      acceptTerms: true,
      paymentToken: "mock-card-ok",
      expectedTotalCents: 13280,
    });
  });

  it("offers only times when every chosen studio is free", async () => {
    busy = { [B]: [[h(10), h(12) + 10]], [D]: [[h(15), h(16) + 10]] };
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    await user.click(studioBox("Studio Blanche"));
    await user.click(studioBox("Studio Dayglow"));
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
    busy = { [B]: [[0, h(14)]], [D]: [[h(13), 1440]] };
    render(<BookingFlow catalog={catalog} navigate={nav.push} />);
    await user.click(studioBox("Studio Blanche"));
    await user.click(studioBox("Studio Dayglow"));
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
    expect(screen.getByRole("checkbox", { name: /Extra people/ })).toBeTruthy();
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
    expect(screen.getByText(/Booking several studios together/).textContent).toBe(
      "Booking several studios together: 15% off when you book exactly 2.",
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
