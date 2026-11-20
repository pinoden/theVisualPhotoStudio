import { afterEach, describe, expect, it, vi } from "vitest";
import { squareProvider, type ChargeRequest, type PayLinkRequest } from "./payments";

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
  customerInitiated: true,
};

const declined = (code: string) =>
  json(400, { errors: [{ category: "PAYMENT_METHOD_ERROR", code, detail: `Authorization error: '${code}'` }] });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Square's two accounts", () => {
  it("are two processors: what the sandbox made is unknown to the live account", () => {
    expect(square("sandbox").name).toBe("square-sandbox");
    expect(square("production").name).toBe("square");
  });
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
      customer_details: { customer_initiated: true, seller_keyed_in: false },
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
    ["CARD_DECLINED_VERIFICATION_REQUIRED", "The card's bank did not confirm this payment. Please try again, or use another card."],
    ["SOME_CODE_ADDED_LATER", "The card was declined."],
  ])("turns Square's %s into a sentence for the customer", async (code, sentence) => {
    stubSquare(declined(code));
    expect(await square().charge(CHARGE)).toEqual({
      ok: false,
      message: sentence,
      detail: `${code}: Authorization error: '${code}'`,
    });
  });

  it("never calls a key sent before with other details a refused card: the first request may have taken the money", async () => {
    // As Square's sandbox answered on 2026-11-20 to a second request under one key with a new note.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    stubSquare(
      json(400, {
        errors: [{ category: "INVALID_REQUEST_ERROR", code: "IDEMPOTENCY_KEY_REUSED", detail: "Different request parameters used for the same idempotency_key." }],
      }),
    );
    expect(await square().charge(CHARGE)).toEqual({
      ok: false,
      unknown: true,
      message: "We could not reach the card processor.",
      detail: "IDEMPOTENCY_KEY_REUSED: Different request parameters used for the same idempotency_key.",
    });
    expect(logged).toHaveBeenCalledTimes(1);
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

/**
 * A booking's card is reserved first and the money taken once the booking is
 * confirmed. The answers below are shaped like those of Square's sandbox on
 * 2026-11-16 (`npm run check:square`).
 */
describe("reserving through Square, then taking or giving back", () => {
  it("asks Square to hold the amount without taking it, and to give it back by itself after a day", async () => {
    const fetchMock = stubSquare(json(200, { payment: { id: "PAY9", status: "APPROVED" } }));
    expect(await square().charge({ ...CHARGE, reserve: true })).toEqual({ ok: true, paymentId: "PAY9" });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ autocomplete: false, delay_action: "CANCEL", delay_duration: "PT24H", idempotency_key: CHARGE.idempotencyKey });
    // An ordinary charge is still taken at once.
    stubSquare(json(200, { payment: { id: "PAY8", status: "COMPLETED" } }));
    expect(await square().charge(CHARGE)).toEqual({ ok: true, paymentId: "PAY8" });
  });

  it("takes the amount, and counts one already taken as taken", async () => {
    const fetchMock = stubSquare(json(200, { payment: { id: "PAY9", status: "COMPLETED" } }));
    expect(await square().capture("PAY9")).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe("https://connect.squareupsandbox.com/v2/payments/PAY9/complete");
    // Square refuses to complete a payment twice; reading it shows it was.
    const invalid = json(400, { errors: [{ code: "BAD_REQUEST", detail: "Payment PAY9 is in state COMPLETED, which is invalid for the requested operation" }] });
    stubSquare(invalid, json(200, { payment: { id: "PAY9", status: "COMPLETED" } }));
    expect(await square().capture("PAY9")).toEqual({ ok: true });
  });

  it("does not take an amount that was given back, and says why", async () => {
    stubSquare(
      json(400, { errors: [{ code: "BAD_REQUEST", detail: "Payment PAY9 is in state CANCELED, which is invalid for the requested operation" }] }),
      json(200, { payment: { id: "PAY9", status: "CANCELED" } }),
    );
    expect(await square().capture("PAY9")).toEqual({ ok: false, message: "BAD_REQUEST: Payment PAY9 is in state CANCELED, which is invalid for the requested operation" });
    stubSquare("down", "down", "down");
    expect(await square().capture("PAY9")).toEqual({ ok: false, unknown: true, message: "No answer from Square" });
  });

  it("gives an amount back, and counts one already given back as given back", async () => {
    const fetchMock = stubSquare(json(200, { payment: { id: "PAY9", status: "CANCELED" } }));
    expect(await square().release("PAY9")).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe("https://connect.squareupsandbox.com/v2/payments/PAY9/cancel");
    stubSquare(json(400, { errors: [{ code: "BAD_REQUEST", detail: "invalid" }] }), json(200, { payment: { id: "PAY9", status: "CANCELED" } }));
    expect(await square().release("PAY9")).toEqual({ ok: true });
  });
});

describe("refunding through Square", () => {
  const REFUND = { paymentId: "PAY1", amountCents: 4400, idempotencyKey: "refund-key-1", reason: "Cancelled by customer" };

  it("sends the payment, the amount and the idempotency key, and accepts a refund Square is still completing", async () => {
    const fetchMock = stubSquare(json(200, { refund: { id: "PAY1_R1", status: "PENDING" } }));
    expect(await square().refund(REFUND)).toEqual({ ok: true, refundId: "PAY1_R1", settled: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://connect.squareupsandbox.com/v2/refunds");
    expect(JSON.parse(String(init?.body))).toEqual({
      idempotency_key: "refund-key-1",
      payment_id: "PAY1",
      amount_money: { amount: 4400, currency: "USD" },
      reason: "Cancelled by customer",
    });
  });

  it("says when Square completed the refund at once", async () => {
    stubSquare(json(200, { refund: { id: "PAY1_R1", status: "COMPLETED" } }));
    expect(await square().refund(REFUND)).toEqual({ ok: true, refundId: "PAY1_R1", settled: true });
  });

  it("asks Square again about a refund it accepted, and reads what became of it", async () => {
    const fetchMock = stubSquare(json(200, { refund: { id: "PAY1_R1", status: "PENDING" } }));
    expect(await square().refundState("PAY1_R1")).toEqual({ state: "pending" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://connect.squareupsandbox.com/v2/refunds/PAY1_R1");
    expect(init?.method).toBe("GET");
    stubSquare(json(200, { refund: { id: "PAY1_R1", status: "COMPLETED" } }));
    expect(await square().refundState("PAY1_R1")).toEqual({ state: "completed" });
    stubSquare(json(200, { refund: { id: "PAY1_R1", status: "REJECTED" } }));
    expect(await square().refundState("PAY1_R1")).toEqual({ state: "rejected", message: "Square marked the refund REJECTED" });
    stubSquare(json(200, { refund: { id: "PAY1_R1", status: "FAILED" } }));
    expect(await square().refundState("PAY1_R1")).toEqual({ state: "rejected", message: "Square marked the refund FAILED" });
  });

  it("concludes nothing about a refund when Square does not answer, or cannot find it", async () => {
    stubSquare("down", "down", "down");
    expect(await square().refundState("PAY1_R1")).toEqual({ state: "unknown", message: "No answer from Square" });
    stubSquare(json(404, { errors: [{ code: "NOT_FOUND", detail: "Refund not found." }] }));
    expect(await square().refundState("PAY1_R1")).toEqual({ state: "unknown", message: "NOT_FOUND: Refund not found." });
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

/**
 * Payment links (Square's Checkout API). The answers below are shaped like
 * the ones Square's sandbox gave on 2026-11-15, when a link was made, paid in
 * the sandbox's test panel, read back, refunded and deleted.
 */
describe("payment links through Square", () => {
  const LINK: PayLinkRequest = {
    amountCents: 6800,
    idempotencyKey: "7d1c5f0e-52a1-4b8e-9d3f-1c2b3a4d5e6f",
    title: "Booking VS-ABC234: Studio Paris, Wed, Nov 18, 2026, 2:00 PM",
    note: "VS-ABC234 Dana Diaz",
    returnUrl: "https://studio.test/pay/7d1c5f0e-52a1-4b8e-9d3f-1c2b3a4d5e6f",
  };
  const made = json(200, {
    payment_link: {
      id: "RCJSRNMKSHU7HVHQ",
      version: 1,
      order_id: "uZrcoM0Ot4poH31Hq089tLtuSyJZY",
      checkout_options: { redirect_url: LINK.returnUrl, ask_for_shipping_address: false },
      url: "https://sandbox.square.link/u/iHSJcdGU",
      long_url: "https://connect.squareupsandbox.com/v2/online-checkout/sandbox-testing-panel/M/RCJSRNMKSHU7HVHQ",
      payment_note: LINK.note,
    },
    related_resources: { orders: [{ id: "uZrcoM0Ot4poH31Hq089tLtuSyJZY", state: "DRAFT" }] },
  });
  const ids = { linkId: "RCJSRNMKSHU7HVHQ", orderId: "uZrcoM0Ot4poH31Hq089tLtuSyJZY" };
  const order = (state: string, tenders?: unknown[]) => json(200, { order: { id: ids.orderId, state, ...(tenders ? { tenders } : {}) } });
  const tender = { id: "yAGJqDXaGj3A", payment_id: "yAGJqDXaGj3A", type: "THIRD_PARTY_CARD", amount_money: { amount: 6800, currency: "USD" } };
  const payment = (status: string) => json(200, { payment: { id: "yAGJqDXaGj3A", status, amount_money: { amount: 6800, currency: "USD" } } });

  it("asks for a link for the amount, with a title, a note and the way back, and never sends the client's email", async () => {
    const fetchMock = stubSquare(made);
    expect(await square().createPayLink(LINK)).toEqual({ ok: true, ...ids, url: "https://sandbox.square.link/u/iHSJcdGU" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://connect.squareupsandbox.com/v2/online-checkout/payment-links");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      idempotency_key: LINK.idempotencyKey,
      quick_pay: { name: LINK.title, price_money: { amount: 6800, currency: "USD" }, location_id: "LOC123" },
      payment_note: "VS-ABC234 Dana Diaz",
      checkout_options: { redirect_url: LINK.returnUrl, ask_for_shipping_address: false },
    });
    // Square refused a whole link over an email address it did not like, so none is sent.
    expect(JSON.stringify(body)).not.toContain("buyer_email");
  });

  it("gives Square's own words when it refuses to make a link", async () => {
    stubSquare(json(400, { errors: [{ category: "INVALID_REQUEST_ERROR", code: "INVALID_VALUE", detail: "The price must be positive." }] }));
    expect(await square().createPayLink(LINK)).toEqual({ ok: false, message: "INVALID_VALUE: The price must be positive." });
    stubSquare("down", "down", "down");
    expect(await square().createPayLink(LINK)).toEqual({ ok: false, message: "Could not reach the payment processor." });
  });

  it("reads an order nobody has paid as an open link", async () => {
    const fetchMock = stubSquare(order("DRAFT"));
    expect(await square().payLinkState(ids)).toEqual({ state: "open" });
    expect(fetchMock.mock.calls[0][0]).toBe(`https://connect.squareupsandbox.com/v2/orders/${ids.orderId}`);
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
    expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined();
  });

  it("reads a paid order: its tender names the payment, and the payment says the money was taken", async () => {
    const fetchMock = stubSquare(order("OPEN", [tender]), payment("COMPLETED"));
    expect(await square().payLinkState(ids)).toEqual({ state: "paid", paymentId: "yAGJqDXaGj3A", amountCents: 6800 });
    expect(fetchMock.mock.calls[1][0]).toBe("https://connect.squareupsandbox.com/v2/payments/yAGJqDXaGj3A");
  });

  it("does not call a link paid while the money has not been taken", async () => {
    stubSquare(order("OPEN", [tender]), payment("APPROVED"));
    expect(await square().payLinkState(ids)).toEqual({ state: "open" });
    stubSquare(order("OPEN", [tender]), payment("FAILED"));
    expect(await square().payLinkState(ids)).toEqual({ state: "open" });
    stubSquare(order("OPEN")); // open, with nothing paid on it
    expect(await square().payLinkState(ids)).toEqual({ state: "open" });
  });

  it("reads a cancelled order as a cancelled link", async () => {
    stubSquare(order("CANCELED"));
    expect(await square().payLinkState(ids)).toEqual({ state: "cancelled" });
  });

  it("concludes nothing when Square does not answer, or the payment cannot be read", async () => {
    stubSquare("down", "down", "down");
    expect(await square().payLinkState(ids)).toEqual({ state: "unknown", message: "No answer from Square" });
    stubSquare(json(404, { errors: [{ code: "NOT_FOUND", detail: "Order not found." }] }));
    expect(await square().payLinkState(ids)).toEqual({ state: "unknown", message: "NOT_FOUND: Order not found." });
    stubSquare(order("OPEN", [tender]), "down", "down", "down");
    expect(await square().payLinkState(ids)).toEqual({ state: "unknown", message: "The payment behind the link could not be read" });
  });

  it("withdraws a link, and counts one that is already gone as withdrawn", async () => {
    const fetchMock = stubSquare(json(200, { id: ids.linkId, cancelled_order_id: ids.orderId }));
    expect(await square().cancelPayLink(ids.linkId)).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe(`https://connect.squareupsandbox.com/v2/online-checkout/payment-links/${ids.linkId}`);
    expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE");

    stubSquare(json(404, { errors: [{ code: "NOT_FOUND" }] }));
    expect(await square().cancelPayLink(ids.linkId)).toEqual({ ok: true });
    stubSquare(json(400, { errors: [{ code: "BAD_REQUEST", detail: "The link cannot be deleted." }] }));
    expect(await square().cancelPayLink(ids.linkId)).toEqual({ ok: false, message: "BAD_REQUEST: The link cannot be deleted." });
    stubSquare("down", "down", "down");
    expect(await square().cancelPayLink(ids.linkId)).toEqual({ ok: false, message: "Could not reach the payment processor." });
  });
});
