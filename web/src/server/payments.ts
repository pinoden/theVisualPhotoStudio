/**
 * Card payments. The rest of the app talks to a PaymentProvider and never to
 * Square directly, so tests and local development can run without credentials.
 */
import { STUDIO_TIME_ZONE } from "@/lib/domain/time";
import { splitName } from "@/lib/names";

export interface ChargeRequest {
  amountCents: number;
  /**
   * One-time card token produced in the browser by Square's card form, typed in by the client, whose bank checked
   * them there when it asked (3-D Secure, `buyerVerification` in src/components/square-card.ts).
   */
  token: string;
  /**
   * The client is paying, in front of the card form, rather than the studio charging them: what the bank is told
   * (Square's `customer_details`), and which payments its check of the card holder applies to. Every charge today is
   * the client's own; one the studio makes without them must say false.
   */
  customerInitiated: boolean;
  /** Same key = same charge. Retries can never charge twice. */
  idempotencyKey: string;
  reference: string;
  note: string;
  buyerEmail: string;
  /** The processor's customer the payment is for: a membership's first month, whose card is then kept (`saveCard`). */
  customerId?: string;
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

/** An answer that is either done, with what it made, or refused, with why (the processor's words, for the record). */
export type Made<T> = ({ ok: true } & T) | { ok: false; message: string };

/**
 * What the processor says of a membership's subscription (follow-up 3). Dates are the studio's days, `YYYY-MM-DD`.
 *  - `pending`: it starts billing on a later day (a membership's first month is paid when it is bought).
 *  - `active`: it bills each month.
 *  - `cancelled`: it bills no more; `endsOn` is the end of the month paid for.
 *  - `stopped`: the processor stopped it, as Square does when a customer's email address is refused.
 */
export type SubscriptionState =
  | {
      state: "pending" | "active" | "cancelled" | "stopped";
      /** The last day of the months paid for, when it has billed. */
      paidThrough: string | null;
      endsOn: string | null;
      /** The months billed so far, each with whether it was paid. */
      invoices: { id: string; paid: boolean; amountCents: number; day: string }[];
    }
  | { state: "unknown"; message: string };

/**
 * A membership's billing (follow-up 3): a customer at the processor, the card of the first month's payment kept for
 * the months after it, and a subscription that charges it monthly. The card is kept by the processor, never by this
 * site.
 */
export interface MembershipBilling {
  createCustomer(input: { email: string; name: string; idempotencyKey: string }): Promise<Made<{ customerId: string }>>;
  /** Keep the card of a payment made minutes ago, for the subscription to charge. */
  saveCard(input: { paymentId: string; customerId: string; idempotencyKey: string }): Promise<Made<{ cardId: string }>>;
  /**
   * A price of one of the site's plans at the processor: its plan (made the first time, then reused) and a variation
   * for this price. A price cannot change under a variation, so a new price is a new variation, and members keep theirs.
   */
  createPlanPrice(input: { planName: string; processorPlanId: string | null; priceCents: number; idempotencyKey: string }): Promise<
    Made<{ processorPlanId: string; variationId: string }>
  >;
  /** Charge the kept card at the variation's price each month from `startDate` on. */
  subscribe(input: { customerId: string; cardId: string; variationId: string; startDate: string; idempotencyKey: string }): Promise<
    Made<{ subscriptionId: string }>
  >;
  /** Bill no more. The month paid for runs to its end, which the answer gives when the processor says. */
  cancelSubscription(subscriptionId: string): Promise<Made<{ endsOn: string | null }>>;
  subscriptionState(subscriptionId: string): Promise<SubscriptionState>;
}

export interface PaymentProvider {
  /**
   * Which processor, and with which keys: Square's sandbox and its live account are two processors, for a payment or a
   * link made with one is unknown to the other. Stored with every payment and link (`provider`), so that the site never
   * asks one about what the other made.
   */
  name: "square" | "square-sandbox" | "mock";
  memberships: MembershipBilling;
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
  /**
   * The processor's own page of a payment it took: Square's receipt, which shows the receipt number its Dashboard finds
   * the payment by (follow-up 5). Square documents no address of a payment's page in its Dashboard, and gives the
   * receipt's only once the payment is completed.
   */
  receiptOf(paymentId: string): Promise<Made<{ url: string }>>;
}

export const MOCK_TOKEN_OK = "mock-card-ok";
export const MOCK_TOKEN_DECLINED = "mock-card-declined";
/**
 * A pretend card that pays, and whose every refund is refused: to try in a
 * browser what happens when a refund does not go through. The booking screen
 * never offers it; a test sends it.
 */
export const MOCK_TOKEN_REFUNDS_REFUSED = "mock-card-refunds-refused";

/**
 * The day `months` months after `day` (both `YYYY-MM-DD`), on the same date, or on the month's last day when it is
 * shorter: what a subscription started on the 31st bills on in February. Counted from the first day each time, as
 * Square's billing anchor is, so March is the 31st again.
 */
export function monthsAfter(day: string, months: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(date, last));
  return first.toISOString().slice(0, 10);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The pretend processor's memberships. It keeps nothing: a subscription's first day and price are in its id, and it
 * bills every month from that day on, each month paid, so that local development sees months go by as days pass.
 */
const mockMemberships: MembershipBilling = {
  async createCustomer(input) {
    return { ok: true, customerId: `mock_customer_${input.idempotencyKey}` };
  },
  async saveCard(input) {
    if (!input.paymentId.startsWith("mock_")) return { ok: false, message: "Unknown payment." };
    return { ok: true, cardId: `mock_card_${input.idempotencyKey}` };
  },
  async createPlanPrice(input) {
    return {
      ok: true,
      processorPlanId: input.processorPlanId ?? `mock_plan_${input.idempotencyKey}`,
      variationId: `mock_variation_${input.priceCents}_${input.idempotencyKey}`,
    };
  },
  async subscribe(input) {
    const price = /^mock_variation_(\d+)_/.exec(input.variationId)?.[1];
    if (!price || !ISO_DAY.test(input.startDate)) return { ok: false, message: "Unknown plan." };
    return { ok: true, subscriptionId: `mock_sub_${input.startDate}_${price}_${input.idempotencyKey}` };
  },
  async cancelSubscription() {
    return { ok: true, endsOn: null };
  },
  async subscriptionState(subscriptionId) {
    const match = /^mock_sub_(\d{4}-\d{2}-\d{2})_(\d+)_/.exec(subscriptionId);
    if (!match) return { state: "unknown", message: "Unknown subscription." };
    const [, start, price] = match;
    const today = new Date().toISOString().slice(0, 10);
    const invoices: { id: string; paid: boolean; amountCents: number; day: string }[] = [];
    for (let n = 0; monthsAfter(start, n) <= today; n++) invoices.unshift({ id: `${subscriptionId}_${n}`, paid: true, amountCents: Number(price), day: monthsAfter(start, n) });
    return { state: invoices.length > 0 ? "active" : "pending", paidThrough: invoices.length > 0 ? monthsAfter(start, invoices.length) : null, endsOn: null, invoices };
  },
};

/** Pretend card processor for development and tests. Moves no money. */
export const mockProvider: PaymentProvider = {
  name: "mock",
  memberships: mockMemberships,
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
  async receiptOf() {
    return { ok: false, message: "This payment was made in test mode, with the pretend card processor, which has no receipt page: no card was charged." };
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
    payment?: { id?: string; status?: string; amount_money?: SquareMoney; receipt_url?: string; receipt_number?: string };
    refund?: { id?: string; status?: string };
    payment_link?: { id?: string; order_id?: string; url?: string };
    order?: {
      state?: string;
      /** What was paid with. For a paid link: one tender, whose payment_id is the Payment. */
      tenders?: { id?: string; payment_id?: string; amount_money?: SquareMoney }[];
    };
    // Memberships. The shapes are what Square's sandbox returned on 2026-11-18.
    customer?: { id?: string };
    card?: { id?: string };
    catalog_object?: { id?: string };
    subscription?: { id?: string; status?: string; charged_through_date?: string; canceled_date?: string; start_date?: string; customer_id?: string };
    invoices?: {
      id?: string;
      status?: string;
      subscription_id?: string;
      payment_requests?: { computed_amount_money?: SquareMoney; due_date?: string }[];
    }[];
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
  // The bank's check of the card holder failed, as with a wrong code, or the token came without one.
  CARD_DECLINED_VERIFICATION_REQUIRED: "The card's bank did not confirm this payment. Please try again, or use another card.",
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

  /** Square's words for a refusal, or what was missing from an answer. */
  const refused = (answer: SquareAnswer | null) =>
    !answer ? "No answer from Square" : inSquaresWords(answer.data.errors ?? []) || `Square answered HTTP ${answer.status}`;

  const memberships: MembershipBilling = {
    async createCustomer(input) {
      const { given, family } = splitName(input.name);
      // No phone number: Square refuses a whole customer over a number it does not like, and the site keeps the phone.
      const answer = await post("/v2/customers", {
        idempotency_key: input.idempotencyKey,
        given_name: given,
        family_name: family,
        email_address: input.email,
      });
      const id = answer?.ok ? answer.data.customer?.id : undefined;
      return id ? { ok: true, customerId: id } : { ok: false, message: refused(answer) };
    },

    async saveCard(input) {
      const answer = await post("/v2/cards", { idempotency_key: input.idempotencyKey, source_id: input.paymentId, card: { customer_id: input.customerId } });
      const id = answer?.ok ? answer.data.card?.id : undefined;
      return id ? { ok: true, cardId: id } : { ok: false, message: refused(answer) };
    },

    async createPlanPrice(input) {
      let processorPlanId = input.processorPlanId;
      if (!processorPlanId) {
        const plan = await post("/v2/catalog/object", {
          idempotency_key: `${input.idempotencyKey}-plan`,
          object: { type: "SUBSCRIPTION_PLAN", id: "#plan", subscription_plan_data: { name: input.planName.slice(0, 255), all_items: false } },
        });
        processorPlanId = plan?.ok ? (plan.data.catalog_object?.id ?? null) : null;
        if (!processorPlanId) return { ok: false, message: refused(plan) };
      }
      const variation = await post("/v2/catalog/object", {
        idempotency_key: `${input.idempotencyKey}-price`,
        object: {
          type: "SUBSCRIPTION_PLAN_VARIATION",
          id: "#price",
          subscription_plan_variation_data: {
            name: `${input.planName}, ${(input.priceCents / 100).toFixed(2)} a month`.slice(0, 255),
            subscription_plan_id: processorPlanId,
            phases: [{ ordinal: 0, cadence: "MONTHLY", pricing: { type: "STATIC", price_money: { amount: input.priceCents, currency: "USD" } } }],
          },
        },
      });
      const variationId = variation?.ok ? variation.data.catalog_object?.id : undefined;
      return variationId ? { ok: true, processorPlanId, variationId } : { ok: false, message: refused(variation) };
    },

    async subscribe(input) {
      const answer = await post("/v2/subscriptions", {
        idempotency_key: input.idempotencyKey,
        location_id: config.locationId,
        plan_variation_id: input.variationId,
        customer_id: input.customerId,
        card_id: input.cardId,
        start_date: input.startDate,
        timezone: STUDIO_TIME_ZONE,
      });
      const id = answer?.ok ? answer.data.subscription?.id : undefined;
      return id ? { ok: true, subscriptionId: id } : { ok: false, message: refused(answer) };
    },

    async cancelSubscription(subscriptionId) {
      const path = `/v2/subscriptions/${encodeURIComponent(subscriptionId)}`;
      const answer = await post(`${path}/cancel`, {});
      if (answer?.ok) return { ok: true, endsOn: answer.data.subscription?.canceled_date ?? null };
      // Cancelled already (Square refuses a second time): read it, and it is as cancelled as it can be.
      const read = await send("GET", path);
      const subscription = read?.ok ? read.data.subscription : undefined;
      if (subscription?.canceled_date || subscription?.status === "CANCELED" || subscription?.status === "DEACTIVATED") {
        return { ok: true, endsOn: subscription.canceled_date ?? null };
      }
      return { ok: false, message: refused(answer) };
    },

    async subscriptionState(subscriptionId) {
      const read = await send("GET", `/v2/subscriptions/${encodeURIComponent(subscriptionId)}`);
      const subscription = read?.ok ? read.data.subscription : undefined;
      if (!subscription?.status) return { state: "unknown", message: refused(read) };
      const found = subscription.customer_id
        ? await post("/v2/invoices/search", { query: { filter: { location_ids: [config.locationId], customer_ids: [subscription.customer_id] } }, limit: 200 })
        : null;
      if (subscription.customer_id && !found?.ok) return { state: "unknown", message: refused(found) };
      const invoices = (found?.data.invoices ?? [])
        .filter((invoice) => invoice.subscription_id === subscriptionId && invoice.id)
        .map((invoice) => ({
          id: invoice.id!,
          paid: invoice.status === "PAID",
          amountCents: invoice.payment_requests?.[0]?.computed_amount_money?.amount ?? 0,
          day: invoice.payment_requests?.[0]?.due_date ?? "",
        }))
        .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
      const status = subscription.status;
      const state =
        status === "PENDING"
          ? subscription.canceled_date ? "cancelled" : "pending"
          : status === "ACTIVE"
            ? subscription.canceled_date ? "cancelled" : "active"
            : status === "CANCELED"
              ? "cancelled"
              : "stopped";
      return { state, paidThrough: subscription.charged_through_date ?? null, endsOn: subscription.canceled_date ?? null, invoices };
    },
  };

  return {
    name: config.environment === "production" ? "square" : "square-sandbox",
    memberships,

    async charge(request) {
      const answer = await post("/v2/payments", {
        source_id: request.token,
        idempotency_key: request.idempotencyKey,
        amount_money: { amount: request.amountCents, currency: "USD" },
        location_id: config.locationId,
        reference_id: request.reference,
        note: request.note.slice(0, 500),
        buyer_email_address: request.buyerEmail,
        ...(request.customerId ? { customer_id: request.customerId } : {}),
        // Who pays: the client, with a card they typed into Square's form themselves, so the bank's check applies.
        customer_details: { customer_initiated: request.customerInitiated, seller_keyed_in: false },
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
      // Its key came before with other details (a new card token on a retry): Square replays only the same request,
      // and what the first one did is not known here. It may have taken the money, so it is never a refused card.
      if (errors.some((error) => error.code === "IDEMPOTENCY_KEY_REUSED")) {
        return { ok: false, unknown: true, message: "We could not reach the card processor.", detail };
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

    async receiptOf(paymentId) {
      const answer = await send("GET", `/v2/payments/${encodeURIComponent(paymentId)}`);
      if (!answer?.ok) return { ok: false, message: refused(answer) };
      const url = answer.data.payment?.receipt_url;
      // Only Square's own pages are opened: the address comes from Square, and the admin is sent to it.
      if (url && SQUARE_RECEIPT.test(url)) return { ok: true, url };
      return {
        ok: false,
        message:
          answer.data.payment?.status === "COMPLETED"
            ? "Square gave no receipt for this payment."
            : `Square has no receipt for this payment, as it is not completed (Square says ${answer.data.payment?.status ?? "nothing of it"}).`,
      };
    },
  };
}

/** The receipts of Square's live account and of its sandbox. */
const SQUARE_RECEIPT = /^https:\/\/(?:[a-z0-9-]+\.)*squareup(?:sandbox)?\.com\/receipt\//i;

export interface PaymentClientConfig {
  mode: "square" | "mock" | "disabled";
  squareApplicationId?: string;
  squareLocationId?: string;
  squareEnvironment?: "sandbox" | "production";
  /** For `disabled` when credentials are set but disagree: why payments are off, for the owners' overview. */
  problem?: string;
}

type Env = Record<string, string | undefined>;

const warned = new Set<string>();

/**
 * Which of Square's two accounts the credentials are for: its sandbox, which
 * moves no money, or the live one. Square's application ids say so themselves
 * (a sandbox one begins with `sandbox-`); `SQUARE_ENVIRONMENT`, when set, must
 * agree. When it does not, or says neither, card payments are off, with a word
 * in the server's log, rather than working with the wrong account: payments
 * and links keep the account that made them, and a site that took the live
 * account for the sandbox would leave live money unseen.
 */
export function squareEnvironment(applicationId: string, declared: string | undefined): "sandbox" | "production" | { problem: string } {
  const fromId = applicationId.trim().startsWith("sandbox-") ? "sandbox" : "production";
  const said = (declared ?? "").trim().toLowerCase();
  if (said === "" || said === fromId) return fromId;
  const account = (environment: string) => (environment === "sandbox" ? "Square's sandbox" : "Square's live account");
  const problem =
    said === "sandbox" || said === "production"
      ? `SQUARE_ENVIRONMENT says ${said}, but the application id is of ${account(fromId)}. Set SQUARE_ENVIRONMENT to ${fromId}, or leave it empty`
      : `SQUARE_ENVIRONMENT is "${declared}", which is neither sandbox nor production`;
  if (!warned.has(problem)) {
    warned.add(problem);
    console.error(`Card payments are off: ${problem}.`);
  }
  return { problem: `Card payments are off: ${problem}.` };
}

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
    const environment = squareEnvironment(applicationId, env.SQUARE_ENVIRONMENT);
    if (typeof environment !== "string") return { provider: null, client: { mode: "disabled", problem: environment.problem } };
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
