"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { requestLoginCode, verifyLoginCode } from "@/server/auth";
import { flushEmailsSoon } from "@/server/runtime";
import { openSession, ownerEmails, safeNextPath } from "@/server/session";

export interface SignInState {
  step: "email" | "code";
  email: string;
  error: string;
  notice: string;
}

/** Both steps of signing in: ask for a code, then check it. */
export async function signInAction(previous: SignInState, formData: FormData): Promise<SignInState> {
  const intent = formData.get("intent");
  const db = await getDb();
  const now = new Date();

  if (intent === "restart") return { step: "email", email: "", error: "", notice: "" };

  if (intent === "request") {
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
