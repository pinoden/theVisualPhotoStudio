// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeBalanceCheck } from "./CodeBalanceCheck";

const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("Check Code Balance", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function check(code: string) {
    const user = userEvent.setup();
    render(<CodeBalanceCheck />);
    const toggle = screen.getByRole("button", { name: "Check Code Balance" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    if (code) await user.type(screen.getByLabelText(/Your code/), code);
    await user.click(screen.getByRole("button", { name: "Check balance" }));
  }

  it("shows what a code is worth, when it ends and what it is for", async () => {
    const fetch = answer(200, {
      ok: true,
      found: true,
      balance: { code: "CREDIT-AAAA-BBBB", title: "Studio credit", status: "usable", remaining: "$75 remaining", expires: "Dec 31, 2026", restrictions: ["Works only with the email address it was sent to."] },
    });
    vi.stubGlobal("fetch", fetch);
    await check("credit-aaaa-bbbb");
    const status = screen.getByRole("status");
    expect(await screen.findByText("$75 remaining")).toBeTruthy();
    expect(status.textContent).toContain("Studio credit · CREDIT-AAAA-BBBB");
    expect(status.textContent).toContain("Valid");
    expect(status.textContent).toContain("Valid until Dec 31, 2026");
    expect(status.textContent).toContain("Works only with the email address it was sent to.");
    const [address, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(address).toBe("/api/code-balance");
    expect(JSON.parse(String(init.body))).toEqual({ code: "credit-aaaa-bbbb" });
  });

  it("says when a code is used up or expired", async () => {
    vi.stubGlobal("fetch", answer(200, { ok: true, found: true, balance: { code: "LATE15", title: "Discount code", status: "expired", remaining: "15% off", expires: "Nov 1, 2026", restrictions: [] } }));
    await check("LATE15");
    expect((await screen.findByText(/^Expired/)).textContent).toBe("Expired on Nov 1, 2026");
    expect(screen.queryByText(/Valid until/)).toBeNull();
  });

  it("says a code was not found, asks for one when the field is empty, and passes on the limit's message", async () => {
    vi.stubGlobal("fetch", answer(200, { ok: true, found: false }));
    await check("nope");
    expect((await screen.findByText(/could not find/)).textContent).toBe("We could not find the code NOPE. Please check it and try again.");
    cleanup();

    const fetch = answer(429, { ok: false, message: "Too many checks. Please wait a few minutes and try again." });
    vi.stubGlobal("fetch", fetch);
    await check("");
    expect(screen.getByText("Enter a code to check.")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
    await userEvent.setup().type(screen.getByLabelText(/Your code/), "SPRING20{Enter}");
    expect(await screen.findByText("Too many checks. Please wait a few minutes and try again.")).toBeTruthy();
  });
});
