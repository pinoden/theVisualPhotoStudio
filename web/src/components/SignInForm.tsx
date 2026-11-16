"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signInAction, type SignInState } from "@/app/account/actions";

const START: SignInState = { step: "email", email: "", error: "", notice: "" };

export function SignInForm({ next, devHint }: { next: string; devHint: boolean }) {
  const [state, action, pending] = useActionState(signInAction, START);

  return (
    <div className="confirmation-card" style={{ textAlign: "left" }}>
      <h2 style={{ textAlign: "center", marginTop: 0 }}>Sign in</h2>
      <p style={{ textAlign: "center", fontSize: ".9rem" }}>
        No password needed. We email you a one-time code. Use the address you book with to see your bookings.
      </p>

      {state.error && (
        <div className="flash flash-error" role="alert">
          {state.error}
        </div>
      )}
      {state.notice && <div className="flash flash-success">{state.notice}</div>}

      {state.step === "email" ? (
        <form action={action}>
          <input type="hidden" name="intent" value="request" />
          <div className="form-group">
            <label className="form-label" htmlFor="sign-in-email">
              Email address
            </label>
            <input
              id="sign-in-email"
              name="email"
              type="email"
              className="form-control"
              autoComplete="email"
              defaultValue={state.email}
              required
            />
          </div>
          <button type="submit" className="btn btn-dark" style={{ width: "100%" }} disabled={pending}>
            {pending ? "Sending…" : "Email me a code"}
          </button>
        </form>
      ) : (
        <>
          <form action={action}>
            <input type="hidden" name="intent" value="verify" />
            <input type="hidden" name="email" value={state.email} />
            <input type="hidden" name="next" value={next} />
            <div className="form-group">
              <label className="form-label" htmlFor="sign-in-code">
                6-digit code
              </label>
              <input
                id="sign-in-code"
                name="code"
                className="form-control"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]*"
                maxLength={8}
                autoFocus
                required
              />
            </div>
            <button type="submit" className="btn btn-dark" style={{ width: "100%" }} disabled={pending}>
              {pending ? "Checking…" : "Sign in"}
            </button>
          </form>
          <form action={action} style={{ marginTop: "1rem", textAlign: "center" }}>
            <input type="hidden" name="intent" value="restart" />
            <button type="submit" className="btn btn-outline" style={{ padding: ".5rem 1.25rem", fontSize: ".78rem" }} disabled={pending}>
              Use a different address
            </button>
          </form>
          {devHint && (
            <p style={{ fontSize: ".8rem", marginTop: "1rem", textAlign: "center" }}>
              Development mode: no email is sent. Find the code at <Link href="/dev/outbox">/dev/outbox</Link>.
            </p>
          )}
        </>
      )}
    </div>
  );
}
