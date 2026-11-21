// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManageBooking } from "./ManageBooking";

// The server actions, as the client component sees them: what each press would answer.
const actions = vi.hoisted(() => ({ cancelBookingAction: vi.fn(), rescheduleBookingAction: vi.fn(), askStudioToMoveAction: vi.fn() }));
vi.mock("@/app/booking/actions", () => actions);
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const asked = (kind: "cancel" | "reschedule") =>
  kind === "cancel"
    ? "You asked on Sat, Nov 14, 2026, 10:00 AM to cancel this booking. It is not finished yet, because we could not yet confirm whether its payment link was paid."
    : "You asked on Sat, Nov 14, 2026, 10:00 AM to release this booking for a reschedule code. It is not done yet, because we could not yet confirm whether its payment link was paid.";

/**
 * The owners' answer of 2026-11-20 to question 23: a cancellation or release the client asked for while the card
 * processor could not say whether the booking's payment link was paid waits (`waitToEnd` in manage.ts). The booking's
 * page and the client's account say so in place of the choices, with a way to ask again.
 */
describe("a booking whose cancellation or release waits for the card processor", () => {
  it("says so in place of the choices, and asks again when pressed", async () => {
    actions.cancelBookingAction.mockResolvedValue({ status: "cancelled", message: "Your booking is cancelled. Nothing was charged to a card for this booking." });
    render(<ManageBooking bookingRef="VS-ABC234" token="secret" choices={null} waiting={{ kind: "cancel", text: asked("cancel") }} />);
    expect(screen.getByRole("status").textContent).toContain(asked("cancel"));
    expect(screen.queryByRole("button", { name: /Cancel booking|Reschedule/ })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Try again now" }));
    expect(actions.cancelBookingAction).toHaveBeenCalledTimes(1);
    const form = actions.cancelBookingAction.mock.calls[0][1] as FormData;
    expect([form.get("ref"), form.get("token"), form.get("seen")]).toEqual(["VS-ABC234", "secret", null]);
    expect((await screen.findByRole("status")).textContent).toContain("Your booking is cancelled.");
  });

  it("asks again for the release, not a cancellation, and says so when it still waits", async () => {
    actions.rescheduleBookingAction.mockResolvedValue({
      status: "waiting",
      message: "We could not confirm with the card processor just now whether the payment link for this booking was paid, so your booking is not released yet.",
    });
    render(<ManageBooking bookingRef="VS-ABC234" choices={null} waiting={{ kind: "reschedule", text: asked("reschedule") }} keepInPlace />);
    await userEvent.click(screen.getByRole("button", { name: "Try again now" }));
    expect(actions.rescheduleBookingAction).toHaveBeenCalledTimes(1);
    expect(actions.cancelBookingAction).not.toHaveBeenCalled();
    expect((actions.rescheduleBookingAction.mock.calls[0][1] as FormData).get("keepInPlace")).toBe("1");
    expect((await screen.findByRole("status")).textContent).toContain("so your booking is not released yet.");
    // What it answered is shown, and not a second button to press at once.
    expect(screen.queryByRole("button", { name: "Try again now" })).toBeNull();
  });
});
