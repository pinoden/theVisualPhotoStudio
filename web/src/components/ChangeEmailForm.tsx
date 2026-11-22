"use client";

import { useActionState } from "react";
import { changeEmailAction, type EmailChangeState } from "@/app/account/actions";
import { EMAIL_FIELD } from "@/lib/parse";

/**
 * A client's change of their email address, in two steps: the new address, then the code emailed to it (question 27).
 * `waiting` is an address a code was sent to a moment ago, so that a reload still asks for its code.
 */
export function ChangeEmailForm({ waiting }: { waiting: string | null }) {
  const start: EmailChangeState = waiting ? { step: "code", email: waiting, error: "", notice: `Enter the code we sent to ${waiting}.` } : { step: "email", email: "", error: "", notice: "" };
  const [state, action, pending] = useActionState(changeEmailAction, start);

  return (
    <>
      {state.error && (
        <div className="flash flash-error" role="alert">
          {state.error}
        </div>
      )}
      {state.notice && (
        <div className="flash flash-success" role="status">
          {state.notice}
        </div>
      )}
      {state.step === "email" && (
        <form action={action}>
          <input type="hidden" name="intent" value="request" />
          <div className="form-group">
            <label className="form-label" htmlFor="new-email">
              New email address
            </label>
            <input id="new-email" name="email" {...EMAIL_FIELD} className="form-control" autoComplete="email" defaultValue={state.email} required />
          </div>
          <button type="submit" className="btn btn-outline btn-small" disabled={pending}>
            {pending ? "Sending…" : "Email a code to the new address"}
          </button>
        </form>
      )}
      {state.step === "code" && (
        <>
          <form action={action}>
            <input type="hidden" name="intent" value="confirm" />
            <div className="form-group">
              <label className="form-label" htmlFor="change-code">
                6-digit code sent to {state.email}
              </label>
              <input
                id="change-code"
                name="code"
                className="form-control"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]*"
                maxLength={8}
                required
              />
            </div>
            <button type="submit" className="btn btn-dark btn-small" disabled={pending}>
              {pending ? "Changing…" : "Change my email address"}
            </button>
          </form>
          <form action={action} style={{ marginTop: ".75rem" }}>
            <input type="hidden" name="intent" value="restart" />
            <button type="submit" className="btn btn-outline btn-small" disabled={pending}>
              Use a different address
            </button>
          </form>
        </>
      )}
    </>
  );
}
