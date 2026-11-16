/**
 * Card payments. The rest of the app talks to a PaymentProvider and never to
 * Square directly, so tests and local development can run without credentials.
 */

export interface ChargeRequest {
  amountCents: number;
  /** One-time card token produced in the browser by Square's card form. */
  token: string;
  /** Same key = same charge. Retries can never charge twice. */
  idempotencyKey: string;
  reference: string;
  note: string;
  buyerEmail: string;
  /**
   * Reserve the amount on the card without taking it yet: `capture` takes it,
   * `release` gives it back, and the processor gives it back by itself if
   * neither happens within `RESERVE_HOURS`. A booking is paid this way, so
   * that a card is never charged for a booking that was not made.
   */
  reserve?: boolean;
}

/** How long a reserved amount waits to be taken before the processor gives it back by itself. */
export const RESERVE_HOURS = 24;

/** The outcome of taking or giving back a reserved amount. `unknown`: no answer came, and nothing is known to have happened. */
export type SettleResult = { ok: true } | { ok: false; message: string; unknown?: boolean };

export type ChargeResult =
  | { ok: true; paymentId: string }
  | {
      ok: false;
      /** A sentence for the customer. */
      message: string;
      /** The processor's own wording, for the record. Not shown to customers. */
      detail?: string;
      /** True when no answer came back: the card may have been charged after all. */
      unknown?: boolean;
    };

export interface RefundRequest {
  /** The processor's id of the payment being refunded. */
  paymentId: string;
  amountCents: number;
  /** Same key = same refund. Retries can never refund twice. */
  idempotencyKey: string;
  reason: string;
}

/**
 * A refund the processor accepted. `settled` says it has also completed: the
 * money is on its way back to the card. Square accepts most refunds as
 * pending and completes them shortly after, and may still reject one then:
 * `refundState` asks again (`checkUnsettledRefunds` in manage.ts).
 */
export type RefundResult = { ok: true; refundId: string; settled: boolean } | { ok: false; message: string };

export type RefundState =
  | { state: "pending" }
  | { state: "completed" }
  /** Accepted, then not made after all: the money did not go back. */
  | { state: "rejected"; message: string }
  /** No answer, or one that says neither: nothing is known to have changed. */
  | { state: "unknown"; message: string };

/**
 * A payment link: a page of the processor where a client pays an amount by
 * card, without this site ever seeing the card. Used for what a booking made
 * in the admin still owes. See src/server/pay-links.ts.
 */
export interface PayLinkRequest {
  amountCents: number;
  /** Same key = same link. A repeat can never make a second one. */
  idempotencyKey: string;
  /** What the client reads as the thing they are paying for. */
  title: string;
  /** Goes on the payment, so that it can be found at the processor by the booking's reference. */
  note: string;
  /** Where the processor sends the client once they have paid. */
  returnUrl: string;
}

export type PayLinkResult = { ok: true; linkId: string; orderId: string; url: string } | { ok: false; message: string };

export type PayLinkState =
  | { state: "open" }
  | { state: "paid"; paymentId: string; amountCents: number }
  | { state: "cancelled" }
  /** No answer, or one that says neither: nothing is known to have changed. */
  | { state: "unknown"; message: string };

export interface PaymentProvider {
  name: "square" | "mock";
  charge(request: ChargeRequest): Promise<ChargeResult>;
  refund(request: RefundRequest): Promise<RefundResult>;
  /** Take an amount reserved with `reserve`. Taking one already taken succeeds. */
  capture(paymentId: string): Promise<SettleResult>;
  /** Give back an amount reserved with `reserve`. Giving back one already given back succeeds. */
  release(paymentId: string): Promise<SettleResult>;
  /** What became of a refund the processor accepted: still pending, completed, or rejected after all. */
  refundState(refundId: string): Promise<RefundState>;
  createPayLink(request: PayLinkRequest): Promise<PayLinkResult>;
  /** Whether the link was paid, is still open, or was cancelled. */
  payLinkState(link: { linkId: string; orderId: string }): Promise<PayLinkState>;
  /** Withdraw a link so that it can no longer be paid. Succeeds for a link that is already gone. */
  cancelPayLink(linkId: string): Promise<{ ok: true } | { ok: false; message: string }>;
}

export const MOCK_TOKEN_OK = "mock-card-ok";
export const MOCK_TOKEN_DECLINED = "mock-card-declined";
/**
 * A pretend card that pays, and whose every refund is refused: to try in a
 * browser what happens when a refund does not go through. The booking screen
 * never offers it; a test sends it.
 */
export const MOCK_TOKEN_REFUNDS_REFUSED = "mock-card-refunds-refused";

/** Pretend card processor for development and tests. Moves no money. */
export const mockProvider: PaymentProvider = {
  name: "mock",
  async charge(request) {
    if (request.token === MOCK_TOKEN_OK) return { ok: true, paymentId: `mock_${request.idempotencyKey}` };
    if (request.token === MOCK_TOKEN_DECLINED) return { ok: false, message: "Card declined." };
    if (request.token === MOCK_TOKEN_REFUNDS_REFUSED) return { ok: true, paymentId: `mock_norefund_${request.idempotencyKey}` };
    return { ok: false, message: "Invalid card token." };
  },
  async refund(request) {
    if (!request.paymentId.startsWith("mock_")) return { ok: false, message: "Unknown payment." };
    if (request.paymentId.startsWith("mock_norefund_")) return { ok: false, message: "The card account is closed (test mode)." };
    return { ok: true, refundId: `mock_refund_${request.idempotencyKey}`, settled: true };
  },
  async capture(paymentId) {
    return paymentId.startsWith("mock_") ? { ok: true } : { ok: false, message: "Unknown payment." };
  },
  async release(paymentId) {
    return paymentId.startsWith("mock_") ? { ok: true } : { ok: false, message: "Unknown payment." };
  },
  async refundState() {
    return { state: "completed" };
  },
  // The pretend processor has no page of its own: the client's page on this site offers a pretend
  // payment instead (`pretendToPay`), which is why a pretend link is never found paid here.
  async createPayLink(request) {
    return { ok: true, linkId: `mock_link_${request.idempotencyKey}`, orderId: `mock_order_${request.idempotencyKey}`, url: request.returnUrl };
  },
  async payLinkState() {
    return { state: "open" };
  },
  async cancelPayLink() {
    return { ok: true };
  },
};

interface SquareConfig {
  accessToken: string;
  locationId: string;
  environment: "sandbox" | "production";
  /** Pause before sending an unanswered request again, multiplied by the attempt number. Tests set 0. */
  retryPauseMs?: number;
}

const SQUARE_API_VERSION = "2025-01-23";
const SQUARE_ATTEMPTS = 3;
const SQUARE_TIMEOUT_MS = 10_000;

interface SquareError {
  category?: string;
  code?: string;
  detail?: string;
}

interface SquareMoney {
  amount?: number;
  currency?: string;
}

interface SquareAnswer {
  ok: boolean;
  status: number;
  data: {
    payment?: { id?: string; status?: string; amount_money?: SquareMoney };
    refund?: { id?: string; status?: string };
    payment_link?: { id?: string; order_id?: string; url?: string };
    order?: {
      state?: string;
      /** What was paid with. For a paid link: one tender, whose payment_id is the Payment. */
      tenders?: { id?: string; payment_id?: string; amount_money?: SquareMoney }[];
    };
    errors?: SquareError[];
  };
}

/**
 * What to tell a customer whose card Square refused. Square answers with a
 * code ("Authorization error: 'CVV_FAILURE'"), not with a sentence.
 */
const CARD_PROBLEMS: Record<string, string> = {
  CVV_FAILURE: "The card's security code is not right.",
  ADDRESS_VERIFICATION_FAILURE: "The postal code does not match the card.",
  INVALID_EXPIRATION: "The card's expiry date is not right.",
  BAD_EXPIRATION: "The card's expiry date is not right.",
  EXPIRATION_FAILURE: "The card's expiry date is not right.",
  CARD_EXPIRED: "The card has expired.",
  INSUFFICIENT_FUNDS: "The card does not have enough funds.",
  CARD_NOT_SUPPORTED: "This kind of card is not accepted.",
  INVALID_CARD: "The card number is not right.",
  PAN_FAILURE: "The card number is not right.",
  INVALID_ACCOUNT: "The card number is not right.",
  CARD_TOKEN_EXPIRED: "The card details went out of date before the payment was sent. Please enter the card again.",
  CARD_TOKEN_USED: "The card details were already used once. Please enter the card again.",
};

function cardProblem(errors: SquareError[]): string {
  for (const error of errors) {
    if (error.code && CARD_PROBLEMS[error.code]) return CARD_PROBLEMS[error.code];
  }
  if (errors.some((error) => error.category === "PAYMENT_METHOD_ERROR")) return "The card was declined.";
  return "The payment could not be processed.";
}

const inSquaresWords = (errors: SquareError[]) =>
  errors.map((error) => [error.code, error.detail].filter(Boolean).join(": ")).join("; ");

export function squareProvider(config: SquareConfig): PaymentProvider {
  const base =
    config.environment === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
  const retryPauseMs = config.retryPauseMs ?? 300;

  /**
   * Send a request to Square. One that gets no answer, or an answer that
   * Square itself failed (5xx), is sent again: every request that changes
   * something carries an idempotency key, so a repeat can never charge or
   * refund twice, and reading or deleting is safe to repeat by nature.
   * Returns null when no attempt was answered.
   */
  async function send(method: "POST" | "GET" | "DELETE", path: string, body?: unknown): Promise<SquareAnswer | null> {
    let last: SquareAnswer | null = null;
    for (let attempt = 1; attempt <= SQUARE_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
            "Content-Type": "application/json",
            "Square-Version": SQUARE_API_VERSION,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(SQUARE_TIMEOUT_MS),
        });
        last = {
          ok: response.ok,
          status: response.status,
          data: (await response.json().catch(() => ({}))) as SquareAnswer["data"],
        };
        if (response.status < 500) return last;
      } catch {
        // No answer: timed out or the connection failed. Try again below.
      }
      if (attempt < SQUARE_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, retryPauseMs * attempt));
    }
    return last;
  }
  const post = (path: string, body: unknown) => send("POST", path, body);

  /**
   * Complete or cancel a reserved payment. A payment that is already where it
   * is asked to go counts as done, so that doing it again is harmless; Square
   * itself answers an error for that, so the payment is read to find out.
   */
  async function settle(paymentId: string, action: "complete" | "cancel", done: "COMPLETED" | "CANCELED"): Promise<SettleResult> {
    const answer = await post(`/v2/payments/${encodeURIComponent(paymentId)}/${action}`, {});
    if (!answer || answer.status >= 500) return { ok: false, unknown: true, message: answer ? `Square answered HTTP ${answer.status}` : "No answer from Square" };
    if (answer.ok && answer.data.payment?.status === done) return { ok: true };
    const read = await send("GET", `/v2/payments/${encodeURIComponent(paymentId)}`);
    if (read?.ok && read.data.payment?.status === done) return { ok: true };
    return { ok: false, message: inSquaresWords(answer.data.errors ?? []) || `Payment status ${answer.data.payment?.status ?? "missing"}, HTTP ${answer.status}` };
  }

  return {
    name: "square",

    async charge(request) {
      const answer = await post("/v2/payments", {
        source_id: request.token,
        idempotency_key: request.idempotencyKey,
        amount_money: { amount: request.amountCents, currency: "USD" },
        location_id: config.locationId,
        reference_id: request.reference,
        note: request.note.slice(0, 500),
        buyer_email_address: request.buyerEmail,
        // Reserved, the payment waits to be completed or cancelled; one left alone is cancelled by Square.
        ...(request.reserve ? { autocomplete: false, delay_action: "CANCEL", delay_duration: `PT${RESERVE_HOURS}H` } : { autocomplete: true }),
      });

      if (!answer || answer.status >= 500) {
        return {
          ok: false,
          unknown: true,
          message: "We could not reach the card processor.",
          detail: answer ? `Square answered HTTP ${answer.status}` : "No answer from Square",
        };
      }
      const { payment, errors = [] } = answer.data;
      // Reserved, a payment is APPROVED: the money is held for us. Otherwise it must be COMPLETED: taken.
      if (answer.ok && payment?.id && payment.status === (request.reserve ? "APPROVED" : "COMPLETED")) return { ok: true, paymentId: payment.id };

      const detail = inSquaresWords(errors) || `Payment status ${payment?.status ?? "missing"}, HTTP ${answer.status}`;
      // A refusal that is not about the card is ours to fix (keys, location, request), so make it visible.
      if (!errors.some((error) => error.category === "PAYMENT_METHOD_ERROR")) {
        console.error(`Square refused a payment for ${request.reference}: ${detail}`);
      }
      return { ok: false, message: cardProblem(errors), detail };
    },

    async refund(request) {
      const answer = await post("/v2/refunds", {
        idempotency_key: request.idempotencyKey,
        payment_id: request.paymentId,
        amount_money: { amount: request.amountCents, currency: "USD" },
        reason: request.reason.slice(0, 190),
      });
      if (!answer) return { ok: false, message: "Could not reach the payment processor." };

      const { refund, errors = [] } = answer.data;
      // Square accepts a refund as PENDING and completes it shortly after.
      const accepted = ["PENDING", "COMPLETED", "APPROVED"].includes(refund?.status ?? "");
      if (answer.ok && refund?.id && accepted) return { ok: true, refundId: refund.id, settled: refund.status === "COMPLETED" };
      // Refund problems are read by the owner, so Square's own words are the useful ones.
      const detail = errors.map((error) => error.detail ?? error.code).filter(Boolean).join("; ");
      return { ok: false, message: detail || `Refund was not accepted (${refund?.status ?? `HTTP ${answer.status}`}).` };
    },

    async capture(paymentId) {
      return settle(paymentId, "complete", "COMPLETED");
    },

    async release(paymentId) {
      return settle(paymentId, "cancel", "CANCELED");
    },

    async refundState(refundId) {
      const answer = await send("GET", `/v2/refunds/${encodeURIComponent(refundId)}`);
      if (!answer) return { state: "unknown", message: "No answer from Square" };
      const status = answer.data.refund?.status;
      if (!answer.ok || !status) {
        return { state: "unknown", message: inSquaresWords(answer.data.errors ?? []) || `Square answered HTTP ${answer.status}` };
      }
      if (status === "COMPLETED") return { state: "completed" };
      if (status === "PENDING" || status === "APPROVED") return { state: "pending" };
      if (status === "REJECTED" || status === "FAILED") return { state: "rejected", message: `Square marked the refund ${status}` };
      return { state: "unknown", message: `Square gave the refund the status ${status}` };
    },

    // Square's Checkout API. The shapes below are what Square's sandbox returned on 2026-11-15:
    // a link's order is DRAFT until it is paid, then OPEN with one tender whose payment_id is an
    // ordinary Payment, which the Refunds API refunds like any other.
    async createPayLink(request) {
      const answer = await post("/v2/online-checkout/payment-links", {
        idempotency_key: request.idempotencyKey,
        quick_pay: {
          name: request.title.slice(0, 255),
          price_money: { amount: request.amountCents, currency: "USD" },
          location_id: config.locationId,
        },
        payment_note: request.note.slice(0, 500),
        // The client's email is deliberately not sent: Square refuses the whole link when it does not
        // like an address, and the client reaches the page from our own email anyway.
        checkout_options: { redirect_url: request.returnUrl, ask_for_shipping_address: false },
      });
      if (!answer) return { ok: false, message: "Could not reach the payment processor." };
      const { payment_link: link, errors = [] } = answer.data;
      if (answer.ok && link?.id && link.order_id && link.url) return { ok: true, linkId: link.id, orderId: link.order_id, url: link.url };
      return { ok: false, message: inSquaresWords(errors) || `Square answered HTTP ${answer.status}` };
    },

    async payLinkState(link) {
      const answer = await send("GET", `/v2/orders/${encodeURIComponent(link.orderId)}`);
      if (!answer) return { state: "unknown", message: "No answer from Square" };
      const order = answer.data.order;
      if (!answer.ok || !order) {
        return { state: "unknown", message: inSquaresWords(answer.data.errors ?? []) || `Square answered HTTP ${answer.status}` };
      }
      if (order.state === "CANCELED") return { state: "cancelled" };
      const tender = order.tenders?.[0];
      const paymentId = tender?.payment_id ?? tender?.id;
      // DRAFT, or anything without a tender: nobody has paid.
      if (order.state === "DRAFT" || !paymentId) return { state: "open" };

      // The order says it was paid. The payment itself has the last word on whether the money was taken.
      const paid = await send("GET", `/v2/payments/${encodeURIComponent(paymentId)}`);
      const payment = paid?.data.payment;
      if (!paid || !paid.ok || !payment) return { state: "unknown", message: "The payment behind the link could not be read" };
      if (payment.status !== "COMPLETED") return { state: "open" };
      const amountCents = payment.amount_money?.amount ?? tender?.amount_money?.amount;
      if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents <= 0) {
        return { state: "unknown", message: "The payment behind the link has no amount" };
      }
      return { state: "paid", paymentId, amountCents };
    },

    async cancelPayLink(linkId) {
      const answer = await send("DELETE", `/v2/online-checkout/payment-links/${encodeURIComponent(linkId)}`);
      if (!answer) return { ok: false, message: "Could not reach the payment processor." };
      // A link that is already gone is as cancelled as it can be.
      if (answer.ok || answer.status === 404) return { ok: true };
      return { ok: false, message: inSquaresWords(answer.data.errors ?? []) || `Square answered HTTP ${answer.status}` };
    },
  };
}

export interface PaymentClientConfig {
  mode: "square" | "mock" | "disabled";
  squareApplicationId?: string;
  squareLocationId?: string;
  squareEnvironment?: "sandbox" | "production";
}

type Env = Record<string, string | undefined>;

/**
 * Which processor to use.
 *  - Square credentials present -> Square.
 *  - PAYMENTS_MODE=mock          -> the pretend processor, stated on screen.
 *  - Otherwise in development    -> the pretend processor.
 *  - Otherwise (production)      -> none: bookings are refused, never free.
 */
export function resolvePayments(env: Env = process.env): { provider: PaymentProvider | null; client: PaymentClientConfig } {
  const accessToken = env.SQUARE_ACCESS_TOKEN;
  const locationId = env.SQUARE_LOCATION_ID;
  const applicationId = env.SQUARE_APPLICATION_ID;
  if (accessToken && locationId && applicationId) {
    const environment = env.SQUARE_ENVIRONMENT === "production" ? "production" : "sandbox";
    return {
      provider: squareProvider({ accessToken, locationId, environment }),
      client: {
        mode: "square",
        squareApplicationId: applicationId,
        squareLocationId: locationId,
        squareEnvironment: environment,
      },
    };
  }
  if (env.PAYMENTS_MODE === "mock" || env.NODE_ENV !== "production") {
    return { provider: mockProvider, client: { mode: "mock" } };
  }
  return { provider: null, client: { mode: "disabled" } };
}
