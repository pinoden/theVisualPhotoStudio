"use client";

import { useEffect, useRef, useState } from "react";
import { splitName } from "@/lib/names";
import type { PaymentClientConfig } from "@/server/payments";

/**
 * Square's card form in the browser: the booking screen and the membership's checkout load it the same way. The card
 * is typed into Square's own frame and becomes a one-time token; the card itself never reaches this site.
 */

/**
 * What the card's bank is told of a payment, so that it can check that the person paying holds the card (3-D Secure).
 * Square's card form asks the bank while it makes the token, and shows the bank's own check on the page when the bank
 * wants one, such as a code sent to the holder's phone. The token is then all a payment needs. This is Square's
 * `tokenize(verificationDetails)`, which replaced `verifyBuyer` and its separate verification token.
 */
export interface BuyerVerification {
  /** In dollars with two decimals, as Square's examples write it: "88.00". */
  amount: string;
  currencyCode: "USD";
  /** CHARGE_AND_STORE when the card is kept and billed again: a membership's first month. */
  intent: "CHARGE" | "CHARGE_AND_STORE";
  billingContact: { givenName: string; familyName?: string; email?: string };
  customerInitiated: true;
  sellerKeyedIn: false;
}

/** What Square's card form answers when asked for a token. */
export interface SquareTokenResult {
  status: string;
  token?: string;
  errors?: { message: string }[];
}

export interface SquareCard {
  attach(selector: string): Promise<void>;
  /** Never without the verification: a token made without it is declined for a card whose bank wants its check. */
  tokenize(verification: BuyerVerification): Promise<SquareTokenResult>;
  destroy(): Promise<void>;
}

/**
 * The verification of a payment of `amountCents` by the client who typed `name` and `email`. Nothing else is given:
 * the site keeps no billing address, and Square refused a whole customer over a phone number it did not like
 * (`createCustomer` in payments.ts), so the phone stays out here too. The amount is what the server charges: it
 * refuses a payment whose total changed from the one on screen.
 */
export function buyerVerification(input: { amountCents: number; intent: BuyerVerification["intent"]; name: string; email: string }): BuyerVerification {
  const { given, family } = splitName(input.name);
  const email = input.email.trim();
  return {
    amount: `${Math.floor(input.amountCents / 100)}.${String(input.amountCents % 100).padStart(2, "0")}`,
    currencyCode: "USD",
    intent: input.intent,
    billingContact: { givenName: given, ...(family ? { familyName: family } : {}), ...(email ? { email } : {}) },
    customerInitiated: true,
    sellerKeyedIn: false,
  };
}

declare global {
  interface Window {
    Square?: { payments(appId: string, locationId: string): { card(): Promise<SquareCard> } };
  }
}

const loading = new Map<string, Promise<void>>();

/**
 * Load a script once. A second call while it is loading waits for the same load: answering at once because its tag is
 * on the page, as this did until 2026-11-18, let a card form started again during the load (React's development mode
 * starts a page twice) find no Square, and show no card fields. One that failed can be tried again.
 */
function loadScript(src: string): Promise<void> {
  let loaded = loading.get(src);
  if (!loaded) {
    loaded = new Promise<void>((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.onload = () => resolve();
      el.onerror = () => {
        loading.delete(src);
        reject(new Error("script failed"));
      };
      document.head.appendChild(el);
    });
    loading.set(src, loaded);
  }
  return loaded;
}

const squareScript = (config: PaymentClientConfig) =>
  config.squareEnvironment === "production" ? "https://web.squarecdn.com/v1/square.js" : "https://sandbox.web.squarecdn.com/v1/square.js";

/** What the card form gives: a one-time token, or why there is none, in words for the client. */
export type CardToken = { ok: true; token: string } | { ok: false; message: string };

/** Square's answer from its card form, with the reason in words when it made no token. */
export function cardTokenOf(result: SquareTokenResult): CardToken {
  if (result.status === "OK" && result.token) return { ok: true, token: result.token };
  const said = (result.errors ?? []).map((error) => error.message).filter(Boolean).join(", ");
  return { ok: false, message: `Card error: ${said || "please check your card details."}` };
}

/** What the client reads when Square's form made no token and gave no reason: the bank's check closed, or failed. */
export const NOT_CONFIRMED = "The card was not confirmed, so nothing was charged. Please try again, or use another card.";

/**
 * The card's token, with the payment's verification. Square's form does not answer but throws when the client closes
 * the bank's check (seen in Square's sandbox on 2026-11-20), and when the check cannot be shown or reach the bank:
 * a payment not confirmed, which the pages would otherwise take for the site out of reach. What Square's form threw is
 * kept in the browser's console, for whoever helps the client.
 */
export async function tokenizeCard(card: SquareCard, verification: BuyerVerification): Promise<CardToken> {
  try {
    return cardTokenOf(await card.tokenize(verification));
  } catch (error) {
    console.error("Square's card form made no token:", error instanceof Error ? error.message : error);
    return { ok: false, message: NOT_CONFIRMED };
  }
}

/** The token the pretend processor takes, in test mode. */
const MOCK_CARD_TOKEN = "mock-card-ok";

/**
 * The payment configuration, and Square's card form attached to the element `containerId` while `active`. The booking
 * screen and the membership's checkout both pay through it.
 *  - `token()` gives the card's one-time token, the card's bank having checked the client when it asked
 *    (`buyerVerification`): the pretend token in test mode, none when no card processor is set up.
 *  - It gives the same token again until `newAttempt()`: a press that follows no answer is the same attempt, sent
 *    again. Square answers a request sent again under its key as it did the first time only when it is the same
 *    request: with a new token it is refused (IDEMPOTENCY_KEY_REUSED) while the first payment may have gone through,
 *    and the client's bank would be asked a second time.
 *  - `newAttempt()`: the attempt is over (any answer but "no answer yet", or a step back), and the next press makes a
 *    new token.
 */
export function useCardForm(active: boolean, containerId: string) {
  const [config, setConfig] = useState<PaymentClientConfig | null>(null);
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState("");
  const card = useRef<SquareCard | null>(null);
  const attemptToken = useRef<string | null>(null);

  useEffect(() => {
    if (!active || config) return;
    fetch("/api/booking-config", { cache: "no-store" })
      .then((response) => response.json())
      .then((answer: PaymentClientConfig) => setConfig(answer))
      .catch(() => setProblem("Could not load the payment form. Please refresh the page."));
  }, [active, config]);

  useEffect(() => {
    if (!active || config?.mode !== "square") return;
    let cancelled = false;
    (async () => {
      if (!window.Square) await loadScript(squareScript(config));
      if (cancelled || !window.Square) return;
      const made = await window.Square.payments(config.squareApplicationId!, config.squareLocationId!).card();
      if (cancelled) return void made.destroy();
      await made.attach(`#${containerId}`);
      card.current = made;
      setReady(true);
    })().catch(() => setProblem("The card form failed to load. Please refresh the page."));
    return () => {
      cancelled = true;
      setReady(false);
      void card.current?.destroy();
      card.current = null;
    };
  }, [active, config, containerId]);

  async function token(verification: BuyerVerification): Promise<CardToken> {
    if (config?.mode === "mock") return { ok: true, token: MOCK_CARD_TOKEN };
    if (attemptToken.current) return { ok: true, token: attemptToken.current };
    if (config?.mode !== "square" || !card.current) return { ok: false, message: "Online payment is not available right now. Please contact the studio." };
    const made = await tokenizeCard(card.current, verification);
    if (made.ok) attemptToken.current = made.token;
    return made;
  }

  function newAttempt() {
    attemptToken.current = null;
  }

  return { config, ready, problem, token, newAttempt };
}
