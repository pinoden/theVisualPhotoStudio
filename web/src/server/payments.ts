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
}

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

export type RefundResult = { ok: true; refundId: string } | { ok: false; message: string };

export interface PaymentProvider {
  name: "square" | "mock";
  charge(request: ChargeRequest): Promise<ChargeResult>;
  refund(request: RefundRequest): Promise<RefundResult>;
}

export const MOCK_TOKEN_OK = "mock-card-ok";
export const MOCK_TOKEN_DECLINED = "mock-card-declined";

/** Pretend card processor for development and tests. Moves no money. */
export const mockProvider: PaymentProvider = {
  name: "mock",
  async charge(request) {
    if (request.token === MOCK_TOKEN_OK) return { ok: true, paymentId: `mock_${request.idempotencyKey}` };
    if (request.token === MOCK_TOKEN_DECLINED) return { ok: false, message: "Card declined." };
    return { ok: false, message: "Invalid card token." };
  },
  async refund(request) {
    if (!request.paymentId.startsWith("mock_")) return { ok: false, message: "Unknown payment." };
    return { ok: true, refundId: `mock_refund_${request.idempotencyKey}` };
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

interface SquareAnswer {
  ok: boolean;
  status: number;
  data: {
    payment?: { id?: string; status?: string };
    refund?: { id?: string; status?: string };
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
   * Square itself failed (5xx), is sent again: every request carries an
   * idempotency key, so a repeat can never charge or refund twice. Returns
   * null when no attempt was answered.
   */
  async function post(path: string, body: unknown): Promise<SquareAnswer | null> {
    let last: SquareAnswer | null = null;
    for (let attempt = 1; attempt <= SQUARE_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(`${base}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
            "Content-Type": "application/json",
            "Square-Version": SQUARE_API_VERSION,
          },
          body: JSON.stringify(body),
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
        autocomplete: true,
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
      if (answer.ok && payment?.id && payment.status === "COMPLETED") return { ok: true, paymentId: payment.id };

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
      if (answer.ok && refund?.id && accepted) return { ok: true, refundId: refund.id };
      // Refund problems are read by the owner, so Square's own words are the useful ones.
      const detail = errors.map((error) => error.detail ?? error.code).filter(Boolean).join("; ");
      return { ok: false, message: detail || `Refund was not accepted (${refund?.status ?? `HTTP ${answer.status}`}).` };
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
