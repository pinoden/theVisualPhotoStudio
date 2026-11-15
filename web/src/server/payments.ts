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

export type ChargeResult = { ok: true; paymentId: string } | { ok: false; message: string };

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
}

const SQUARE_API_VERSION = "2025-01-23";

export function squareProvider(config: SquareConfig): PaymentProvider {
  const base =
    config.environment === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
  return {
    name: "square",
    async charge(request) {
      try {
        const response = await fetch(`${base}/v2/payments`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
            "Content-Type": "application/json",
            "Square-Version": SQUARE_API_VERSION,
          },
          body: JSON.stringify({
            source_id: request.token,
            idempotency_key: request.idempotencyKey,
            amount_money: { amount: request.amountCents, currency: "USD" },
            location_id: config.locationId,
            reference_id: request.reference,
            note: request.note.slice(0, 500),
            buyer_email_address: request.buyerEmail,
            autocomplete: true,
          }),
        });
        const data = (await response.json().catch(() => ({}))) as {
          payment?: { id?: string; status?: string };
          errors?: { detail?: string; code?: string }[];
        };
        if (response.ok && data.payment?.id && data.payment.status === "COMPLETED") {
          return { ok: true, paymentId: data.payment.id };
        }
        const detail = data.errors?.map((e) => e.detail ?? e.code).filter(Boolean).join("; ");
        return { ok: false, message: detail || `Payment was not completed (${data.payment?.status ?? response.status}).` };
      } catch {
        return { ok: false, message: "Could not reach the payment processor. You were not charged." };
      }
    },

    async refund(request) {
      try {
        const response = await fetch(`${base}/v2/refunds`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
            "Content-Type": "application/json",
            "Square-Version": SQUARE_API_VERSION,
          },
          body: JSON.stringify({
            idempotency_key: request.idempotencyKey,
            payment_id: request.paymentId,
            amount_money: { amount: request.amountCents, currency: "USD" },
            reason: request.reason.slice(0, 190),
          }),
        });
        const data = (await response.json().catch(() => ({}))) as {
          refund?: { id?: string; status?: string };
          errors?: { detail?: string; code?: string }[];
        };
        // Square accepts a refund as PENDING and completes it shortly after.
        const accepted = ["PENDING", "COMPLETED", "APPROVED"].includes(data.refund?.status ?? "");
        if (response.ok && data.refund?.id && accepted) return { ok: true, refundId: data.refund.id };
        const detail = data.errors?.map((e) => e.detail ?? e.code).filter(Boolean).join("; ");
        return { ok: false, message: detail || `Refund was not accepted (${data.refund?.status ?? response.status}).` };
      } catch {
        return { ok: false, message: "Could not reach the payment processor." };
      }
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
