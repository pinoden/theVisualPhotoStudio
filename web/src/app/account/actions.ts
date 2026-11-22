"use server";

import { refresh } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { requestLoginCode, verifyLoginCode } from "@/server/auth";
import { confirmEmailChange, requestEmailChange } from "@/server/email-change";
import { mayUseTestTools } from "@/server/browser-test-server";
import { clientAddress, limitRate } from "@/server/rate-limit";
import { flushEmailsSoon } from "@/server/runtime";
import { getCurrentUser, openSession, ownerEmails, safeNextPath } from "@/server/session";

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

export interface EmailChangeState {
  step: "email" | "code" | "done";
  /** The new address: typed, waiting for its code, or the account's now. */
  email: string;
  error: string;
  notice: string;
}

const CHANGE_REFUSED: Record<string, string> = {
  invalid_email: "Please enter a valid email address.",
  same: "That is the address your account has already.",
  in_use:
    "We already have bookings or codes under that address. To bring the two together, please contact us: we can join them for you.",
  not_customer: "The studio's team cannot change their address here. Please ask an owner.",
  member:
    "Your membership is billed under your current address. To change it, please contact us, and we will change it with the card processor too.",
  too_many: "Too many codes were asked for. Please wait 15 minutes and try again.",
  invalid: "That code is not right, or it has expired.",
  too_many_tries: "Too many wrong codes. Please ask for a new code.",
};

/**
 * A client changes their account's email address (question 27): first a code to the new address, then the code back.
 * Limited per network like signing in.
 */
export async function changeEmailAction(previous: EmailChangeState, formData: FormData): Promise<EmailChangeState> {
  const user = await getCurrentUser();
  if (!user) return { ...previous, error: "Please sign in again.", notice: "" };
  const intent = formData.get("intent");
  if (intent === "restart") return { step: "email", email: "", error: "", notice: "" };
  const db = await getDb();
  const now = new Date();
  const address = clientAddress(await headers());
  if (!(await limitRate(db, { key: `email-change:${address}`, max: perAddress, windowMs: SIGN_IN_WINDOW_MS }, now)).allowed) {
    return { ...previous, notice: "", error: TOO_MANY_HERE };
  }

  if (intent === "request") {
    const typed = String(formData.get("email") ?? "").trim().slice(0, 200);
    const result = await requestEmailChange(db, user, formData.get("email"), now);
    if (!result.ok) return { step: "email", email: typed, notice: "", error: CHANGE_REFUSED[result.code] };
    flushEmailsSoon();
    return { step: "code", email: result.email, error: "", notice: `We sent a 6-digit code to ${result.email}. Enter it here to make the change.` };
  }

  if (intent === "confirm") {
    const result = await confirmEmailChange(db, user, formData.get("code"), now);
    if (!result.ok) {
      const back = result.code === "in_use" || result.code === "member" || result.code === "not_customer";
      return { step: back ? "email" : "code", email: previous.email, notice: "", error: CHANGE_REFUSED[result.code] };
    }
    flushEmailsSoon();
    // The page around the form shows the account's address: drawn again with the new one.
    refresh();
    return { step: "done", email: result.email, error: "", notice: `Your email address is now ${result.email}. Your bookings, receipts, stamps and codes are under it, and our emails go there.` };
  }

  return previous;
}
