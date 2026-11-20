// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buyerVerification, useCardForm, type SquareCard } from "./square-card";

/** Square's card form as the site sees it: the tokens it makes, one after another. */
let tokenize: ReturnType<typeof vi.fn<SquareCard["tokenize"]>>;

beforeEach(() => {
  let made = 0;
  tokenize = vi.fn<SquareCard["tokenize"]>(async () => ({ status: "OK", token: `token-${++made}` }));
  const card: SquareCard = { attach: async () => {}, destroy: async () => {}, tokenize };
  // Square's script, already on the page: nothing is loaded.
  window.Square = { payments: () => ({ card: async () => card }) };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ mode: "square", squareApplicationId: "sandbox-app", squareLocationId: "LOC", squareEnvironment: "sandbox" }))),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.Square;
});

const verification = buyerVerification({ amountCents: 6800, intent: "CHARGE", name: "Jane Smith", email: "jane@client.test" });

describe("the card form's token for an attempt to pay", () => {
  it("is made once for an attempt and given again to a press after no answer, until the attempt is over", async () => {
    const { result } = renderHook(() => useCardForm(true, "card"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(await result.current.token(verification)).toEqual({ ok: true, token: "token-1" });
    // Pressed again after no answer: the same request goes to Square, and the client's bank is not asked again.
    expect(await result.current.token(verification)).toEqual({ ok: true, token: "token-1" });
    expect(tokenize).toHaveBeenCalledTimes(1);

    act(() => result.current.newAttempt());
    expect(await result.current.token(verification)).toEqual({ ok: true, token: "token-2" });
    expect(tokenize).toHaveBeenCalledTimes(2);
  });

  it("is not kept when Square made none: the next press asks the card form again", async () => {
    tokenize.mockResolvedValueOnce({ status: "Invalid", errors: [{ message: "Card number is not valid" }] });
    const { result } = renderHook(() => useCardForm(true, "card"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(await result.current.token(verification)).toEqual({ ok: false, message: "Card error: Card number is not valid" });
    expect(await result.current.token(verification)).toEqual({ ok: true, token: "token-1" });
    expect(tokenize).toHaveBeenCalledTimes(2);
  });

  it("asks the card form with the payment's verification", async () => {
    const { result } = renderHook(() => useCardForm(true, "card"));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await result.current.token(verification);
    expect(tokenize).toHaveBeenCalledWith(verification);
  });
});
