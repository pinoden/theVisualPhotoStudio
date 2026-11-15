import { afterEach, describe, expect, it, vi } from "vitest";
import { squareProvider, type ChargeRequest } from "./payments";

/**
 * The Square code against answers shaped like Square's real ones. The
 * decline codes and the refund wording were seen in a run against Square's
 * sandbox (`npm run check:square`); these tests keep them without calling
 * Square.
 */

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

/** Answer successive requests with the given replies; "down" means the request gets no answer. */
function stubSquare(...replies: (Response | "down")[]) {
  const mock = vi.fn<Fetch>(async () => {
    const reply = replies.shift();
    if (!reply || reply === "down") throw new TypeError("fetch failed");
    return reply;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

const square = (environment: "sandbox" | "production" = "sandbox") =>
  squareProvider({ accessToken: "test-token", locationId: "LOC123", environment, retryPauseMs: 0 });

const CHARGE: ChargeRequest = {
  amountCents: 8800,
  token: "cnon:card-nonce-ok",
  idempotencyKey: "0b1f6f8e-3a4f-4c7c-9a52-6d7a0c5d1e10",
  reference: "VS-ABC234",
  note: "VS-ABC234 Studio Blanche, Jane Smith",
  buyerEmail: "jane@example.com",
};

const declined = (code: string) =>
  json(400, { errors: [{ category: "PAYMENT_METHOD_ERROR", code, detail: `Authorization error: '${code}'` }] });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("charging through Square", () => {
  it("sends the amount, the card token and the idempotency key, and returns Square's payment id", async () => {
    const fetchMock = stubSquare(json(200, { payment: { id: "PAY1", status: "COMPLETED" } }));
    expect(await square().charge(CHARGE)).toEqual({ ok: true, paymentId: "PAY1" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://connect.squareupsandbox.com/v2/payments");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token");
    expect(new Headers(init?.headers).get("Square-Version")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(JSON.parse(String(init?.body))).toEqual({
      source_id: "cnon:card-nonce-ok",
      idempotency_key: CHARGE.idempotencyKey,
      amount_money: { amount: 8800, currency: "USD" },
      location_id: "LOC123",
      reference_id: "VS-ABC234",
      note: "VS-ABC234 Studio Blanche, Jane Smith",
      buyer_email_address: "jane@example.com",
      autocomplete: true,
    });
  });

  it("talks to the live address only when told it is production", async () => {
    const fetchMock = stubSquare(json(200, { payment: { id: "PAY1", status: "COMPLETED" } }));
    await square("production").charge(CHARGE);
    expect(fetchMock.mock.calls[0][0]).toBe("https://connect.squareup.com/v2/payments");
  });

  it.each([
    ["GENERIC_DECLINE", "The card was declined."],
    ["CVV_FAILURE", "The card's security code is not right."],
    ["ADDRESS_VERIFICATION_FAILURE", "The postal code does not match the card."],
    ["INVALID_EXPIRATION", "The card's expiry date is not right."],
    ["CARD_EXPIRED", "The card has expired."],
    ["INSUFFICIENT_FUNDS", "The card does not have enough funds."],
    ["SOME_CODE_ADDED_LATER", "The card was declined."],
  ])("turns Square's %s into a sentence for the customer", async (code, sentence) => {
    stubSquare(declined(code));
    expect(await square().charge(CHARGE)).toEqual({
      ok: false,
      message: sentence,
      detail: `${code}: Authorization error: '${code}'`,
    });
  });

  it("does not call a payment taken until Square says it is completed", async () => {
    stubSquare(json(200, { payment: { id: "PAY1", status: "APPROVED" } }));
    expect(await square().charge(CHARGE)).toMatchObject({ ok: false, message: "The payment could not be processed." });
  });

  it("hides a refusal that is about the site's own set-up from the customer, and logs it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    stubSquare(
      json(401, {
        errors: [{ category: "AUTHENTICATION_ERROR", code: "UNAUTHORIZED", detail: "This request could not be authorized." }],
      }),
    );
    expect(await square().charge(CHARGE)).toEqual({
      ok: false,
      message: "The payment could not be processed.",
      detail: "UNAUTHORIZED: This request could not be authorized.",
    });
    expect(logged).toHaveBeenCalledWith(
      "Square refused a payment for VS-ABC234: UNAUTHORIZED: This request could not be authorized.",
    );
    expect(JSON.stringify(logged.mock.calls)).not.toContain("test-token");
  });

  it("sends an unanswered request again with the same key, and succeeds when Square answers", async () => {
    const fetchMock = stubSquare("down", json(503, {}), json(200, { payment: { id: "PAY1", status: "COMPLETED" } }));
    expect(await square().charge(CHARGE)).toEqual({ ok: true, paymentId: "PAY1" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const keys = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).idempotency_key);
    expect(new Set(keys)).toEqual(new Set([CHARGE.idempotencyKey]));
  });

  it("reports that the outcome is unknown when Square never answers", async () => {
    const fetchMock = stubSquare("down", "down", "down");
    expect(await square().charge(CHARGE)).toEqual({
      ok: false,
      unknown: true,
      message: "We could not reach the card processor.",
      detail: "No answer from Square",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not repeat a request that Square answered with a refusal", async () => {
    const fetchMock = stubSquare(declined("GENERIC_DECLINE"));
    await square().charge(CHARGE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("refunding through Square", () => {
  const REFUND = { paymentId: "PAY1", amountCents: 4400, idempotencyKey: "refund-key-1", reason: "Cancelled by customer" };

  it("sends the payment, the amount and the idempotency key, and accepts a refund Square is still completing", async () => {
    const fetchMock = stubSquare(json(200, { refund: { id: "PAY1_R1", status: "PENDING" } }));
    expect(await square().refund(REFUND)).toEqual({ ok: true, refundId: "PAY1_R1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://connect.squareupsandbox.com/v2/refunds");
    expect(JSON.parse(String(init?.body))).toEqual({
      idempotency_key: "refund-key-1",
      payment_id: "PAY1",
      amount_money: { amount: 4400, currency: "USD" },
      reason: "Cancelled by customer",
    });
  });

  it("passes Square's own explanation on, for the owner", async () => {
    stubSquare(json(400, { errors: [{ detail: "The requested refund amount exceeds the amount available to refund." }] }));
    expect(await square().refund(REFUND)).toEqual({
      ok: false,
      message: "The requested refund amount exceeds the amount available to refund.",
    });
  });

  it("fails, to be tried again later, when Square never answers or rejects the refund", async () => {
    stubSquare("down", "down", "down");
    expect(await square().refund(REFUND)).toEqual({ ok: false, message: "Could not reach the payment processor." });
    stubSquare(json(200, { refund: { id: "PAY1_R1", status: "REJECTED" } }));
    expect(await square().refund(REFUND)).toEqual({ ok: false, message: "Refund was not accepted (REJECTED)." });
  });
});
