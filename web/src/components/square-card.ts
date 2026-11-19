"use client";

import { useEffect, useRef, useState } from "react";
import type { PaymentClientConfig } from "@/server/payments";

/**
 * Square's card form in the browser: the booking screen and the membership's checkout load it the same way. The card
 * is typed into Square's own frame and becomes a one-time token; the card itself never reaches this site.
 */

export interface SquareCard {
  attach(selector: string): Promise<void>;
  tokenize(): Promise<{ status: string; token?: string; errors?: { message: string }[] }>;
  destroy(): Promise<void>;
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
export function loadScript(src: string): Promise<void> {
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

export const squareScript = (config: PaymentClientConfig) =>
  config.squareEnvironment === "production" ? "https://web.squarecdn.com/v1/square.js" : "https://sandbox.web.squarecdn.com/v1/square.js";

/** What the card form gives: a one-time token, or why there is none, in words for the client. */
export type CardToken = { ok: true; token: string } | { ok: false; message: string };

/** The token the pretend processor takes, in test mode. */
export const MOCK_CARD_TOKEN = "mock-card-ok";

/**
 * The payment configuration, and Square's card form attached to the element `containerId` while `active`. `token()`
 * gives the card's one-time token: the pretend one in test mode, none when no card processor is set up.
 */
export function useCardForm(active: boolean, containerId: string) {
  const [config, setConfig] = useState<PaymentClientConfig | null>(null);
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState("");
  const card = useRef<SquareCard | null>(null);

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

  async function token(): Promise<CardToken> {
    if (config?.mode === "mock") return { ok: true, token: MOCK_CARD_TOKEN };
    if (config?.mode !== "square" || !card.current) return { ok: false, message: "Online payment is not available right now. Please contact the studio." };
    const result = await card.current.tokenize();
    if (result.status !== "OK" || !result.token) {
      return { ok: false, message: `Card error: ${(result.errors ?? []).map((error) => error.message).join(", ") || "please check your card details."}` };
    }
    return { ok: true, token: result.token };
  }

  return { config, ready, problem, token };
}
