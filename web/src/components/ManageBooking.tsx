"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { askStudioToMoveAction, cancelBookingAction, rescheduleBookingAction, type ManageState } from "@/app/booking/actions";

const IDLE: ManageState = { status: "idle", message: "" };

export interface ManageChoice {
  allowed: boolean;
  /** What will happen, or why it is not possible. */
  text: string;
  /** False when the studio does not offer this at all: its button is then left out. */
  offered?: boolean;
}

/**
 * Cancel and reschedule buttons for one booking. Each asks for confirmation
 * and says beforehand exactly what will happen to the customer's money.
 * `choices` is null once the booking is no longer active; the component stays
 * mounted so the result of the action remains on screen. While a cancellation
 * or release the client asked for waits for the card processor (`waiting`),
 * it says so in their place, with a button that asks again.
 */
export function ManageBooking({
  bookingRef,
  token,
  choices,
  waiting = null,
  keepInPlace = false,
}: {
  bookingRef: string;
  /** The secret from the customer's link. Omitted for a signed-in customer. */
  token?: string;
  choices: { cancel: ManageChoice; reschedule: ManageChoice; request?: ManageChoice } | null;
  /** What the client asked for that waits (`endRequestText` in manage.ts): `choices` is then null. */
  waiting?: { kind: "cancel" | "reschedule"; text: string } | null;
  /**
   * In a list, the page is not re-rendered after the action: the booking's
   * card would move away and take the result message with it.
   */
  keepInPlace?: boolean;
}) {
  const [cancelState, cancelAction, cancelling] = useActionState(cancelBookingAction, IDLE);
  const [moveState, moveAction, moving] = useActionState(rescheduleBookingAction, IDLE);
  const [requestState, requestAction, requesting] = useActionState(askStudioToMoveAction, IDLE);
  const [asking, setAsking] = useState<"cancel" | "move" | "request" | null>(null);
  const busy = cancelling || moving || requesting;

  const result =
    moveState.status === "rescheduled"
      ? moveState
      : cancelState.status === "cancelled"
        ? cancelState
        : requestState.status === "requested"
          ? requestState
          : cancelState.status === "waiting"
            ? cancelState
            : moveState.status === "waiting"
              ? moveState
              : null;
  const error =
    cancelState.status === "error"
      ? cancelState.message
      : moveState.status === "error"
        ? moveState.message
        : requestState.status === "error"
          ? requestState.message
          : "";

  if (result) {
    return (
      <div className="notice" role="status">
        <p style={{ marginTop: 0 }}>{result.message}</p>
        {result.code && result.bookPath && (
          <>
            <div className="booking-ref" style={{ textAlign: "center", margin: "1rem 0" }}>
              {result.code}
            </div>
            <p style={{ marginBottom: 0 }}>
              <Link href={result.bookPath} className="btn btn-dark">
                Book a new time
              </Link>
            </p>
          </>
        )}
      </div>
    );
  }

  const hidden = (
    <>
      <input type="hidden" name="ref" value={bookingRef} />
      {token && <input type="hidden" name="token" value={token} />}
      {keepInPlace && <input type="hidden" name="keepInPlace" value="1" />}
    </>
  );

  // What the client asked for waits for the card processor: said in place of the choices, with a way to ask again.
  if (waiting) {
    return (
      <div className="notice" role="status">
        {error && (
          <div className="flash flash-error" role="alert">
            {error}
          </div>
        )}
        <p style={{ marginTop: 0 }}>{waiting.text}</p>
        <form action={waiting.kind === "cancel" ? cancelAction : moveAction} style={{ marginBottom: 0 }}>
          {hidden}
          <button type="submit" className="btn btn-outline btn-small" disabled={busy}>
            {busy ? "Checking…" : "Try again now"}
          </button>
        </form>
      </div>
    );
  }

  // Nothing left to choose (the booking ended meanwhile): what the last press was told still shows.
  if (!choices) {
    return error ? (
      <div className="flash flash-error" role="alert">
        {error}
      </div>
    ) : null;
  }

  return (
    <div className="manage-booking">
      {error && (
        <div className="flash flash-error" role="alert">
          {error}
        </div>
      )}

      {asking === null && (
        <div style={{ display: "flex", gap: ".75rem", flexWrap: "wrap" }}>
          {choices.reschedule.offered !== false && (
            <button type="button" className="btn btn-outline" onClick={() => setAsking("move")} disabled={busy}>
              Reschedule
            </button>
          )}
          <button type="button" className="btn btn-outline" onClick={() => setAsking("cancel")} disabled={busy}>
            Cancel booking
          </button>
          {choices.request?.allowed && (
            <button type="button" className="btn btn-outline" onClick={() => setAsking("request")} disabled={busy}>
              Ask the studio to move it
            </button>
          )}
        </div>
      )}
      {asking === null && choices.request && !choices.request.allowed && choices.request.text && (
        <p style={{ fontSize: ".85rem", marginBottom: 0 }}>{choices.request.text}</p>
      )}

      {asking === "request" && choices.request && (
        <div className="notice">
          <strong style={{ color: "var(--color-dark)" }}>Ask the studio to move this booking?</strong>
          <p>{choices.request.text}</p>
          <form action={requestAction}>
            {hidden}
            <label className="form-label" htmlFor={`move-request-${bookingRef}`}>
              When would suit you?
            </label>
            <textarea
              id={`move-request-${bookingRef}`}
              name="message"
              className="form-control"
              rows={3}
              maxLength={1000}
              required
              placeholder="For example: any weekday afternoon next week"
            />
            <div style={{ display: "flex", gap: ".75rem", flexWrap: "wrap", marginTop: ".75rem" }}>
              <button type="submit" className="btn btn-dark" disabled={busy}>
                {requesting ? "Sending…" : "Send my request"}
              </button>
              <button type="button" className="btn btn-outline" onClick={() => setAsking(null)} disabled={busy}>
                Back
              </button>
            </div>
          </form>
        </div>
      )}

      {asking === "move" && (
        <div className="notice">
          <strong style={{ color: "var(--color-dark)" }}>Reschedule this booking?</strong>
          <p>{choices.reschedule.text}</p>
          <form action={moveAction} style={{ display: "flex", gap: ".75rem", flexWrap: "wrap" }}>
            {hidden}
            {/* What the client was told: if moving would give something else now, nothing is done until they look again. */}
            <input type="hidden" name="seen" value={choices.reschedule.text} />
            {choices.reschedule.allowed && (
              <button type="submit" className="btn btn-dark" disabled={busy}>
                {moving ? "Working…" : "Yes, release it and send my code"}
              </button>
            )}
            <button type="button" className="btn btn-outline" onClick={() => setAsking(null)} disabled={busy}>
              {choices.reschedule.allowed ? "Keep my booking" : "Back"}
            </button>
          </form>
        </div>
      )}

      {asking === "cancel" && (
        <div className="notice">
          <strong style={{ color: "var(--color-dark)" }}>Cancel this booking?</strong>
          <p>{choices.cancel.text}</p>
          {choices.cancel.allowed && choices.reschedule.allowed && (
            <p style={{ fontSize: ".85rem" }}>You can also reschedule instead, for a code to book a new time.</p>
          )}
          <form action={cancelAction} style={{ display: "flex", gap: ".75rem", flexWrap: "wrap" }}>
            {hidden}
            {/* What the client was told: if cancelling would give back something else now, nothing is done until they look again. */}
            <input type="hidden" name="seen" value={choices.cancel.text} />
            {choices.cancel.allowed && (
              <button type="submit" className="btn btn-dark" disabled={busy}>
                {cancelling ? "Working…" : "Yes, cancel it"}
              </button>
            )}
            <button type="button" className="btn btn-outline" onClick={() => setAsking(null)} disabled={busy}>
              {choices.cancel.allowed ? "Keep my booking" : "Back"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
