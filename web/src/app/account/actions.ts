"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { requestLoginCode, verifyLoginCode } from "@/server/auth";
import { mayUseTestTools } from "@/server/browser-test-server";
import { clientAddress, limitRate } from "@/server/rate-limit";
import { flushEmailsSoon } from "@/server/runtime";
import { openSession, ownerEmails, safeNextPath } from "@/server/session";

export interface SignInState {
  step: "email" | "code";
  email: string;
  error: string;
  notice: string;
}

// From one address in 15 minutes: ten codes asked for, thirty codes tried, counted in the database (the security review
// of 2026-11-19). The browser tests all come from one address and sign in more often than that, so their server raises
// the number with SIGN_IN_REQUESTS_PER_IP. Production ignores it, but on their own server (`mayUseTestTools`).
const perAddress = mayUseTestTools() ? Number(process.env.SIGN_IN_REQUESTS_PER_IP) || 10 : 10;
const SIGN_IN_WINDOW_MS = 15 * 60_000;
const TOO_MANY_HERE = "Too many sign-in attempts from this network. Please wait 15 minutes and try again.";

/** Both steps of signing in: ask for a code, then check it. */
export async function signInAction(previous: SignInState, formData: FormData): Promise<SignInState> {
  const intent = formData.get("intent");
  const db = await getDb();
  const now = new Date();

  if (intent === "restart") return { step: "email", email: "", error: "", notice: "" };

  if (intent === "request") {
    const address = clientAddress(await headers());
    if (!(await limitRate(db, { key: `sign-in-code:${address}`, max: perAddress, windowMs: SIGN_IN_WINDOW_MS }, now)).allowed) {
      return { ...previous, email: String(formData.get("email") ?? "").trim().slice(0, 200), notice: "", error: TOO_MANY_HERE };
    }
    const result = await requestLoginCode(db, formData.get("email"), now);
    if (!result.ok) {
      return {
        ...previous,
        // What was typed comes back in the field, to be put right.
        email: String(formData.get("email") ?? "").trim().slice(0, 200),
        notice: "",
        error:
          result.code === "too_many"
            ? "Too many codes were requested for this address. Please wait 15 minutes and try again."
            : "Please enter a valid email address.",
      };
    }
    flushEmailsSoon();
    return { step: "code", email: result.email, error: "", notice: `We sent a 6-digit code to ${result.email}.` };
  }

  if (intent === "verify") {
    const email = String(formData.get("email") ?? "");
    const address = clientAddress(await headers());
    if (!(await limitRate(db, { key: `sign-in-try:${address}`, max: perAddress * 3, windowMs: SIGN_IN_WINDOW_MS }, now)).allowed) {
      return { step: "code", email, notice: "", error: TOO_MANY_HERE };
    }
    const result = await verifyLoginCode(db, email, formData.get("code"), { now, ownerEmails: ownerEmails() });
    if (!result.ok) {
      return {
        step: "code",
        email,
        notice: "",
        error:
          result.code === "too_many_attempts"
            ? "Too many wrong codes. Please request a new code."
            : "That code is not right, or it has expired.",
      };
    }
    await openSession(result.sessionToken, result.expiresAt);
    redirect(safeNextPath(formData.get("next")));
  }

  return previous;
}
