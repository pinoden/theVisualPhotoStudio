"use client";

import { useActionState, useState } from "react";
import { cancelMembershipAction, type CancelMembershipState } from "@/app/account/membership/actions";

/**
 * "Cancel membership", asked twice: the monthly payments stop, the month paid for runs on, and the hours stay. The
 * member's own in their account; an owner's on the member's page, with its own action and words (`who`).
 */
export function CancelMembership({
  membershipId,
  planName,
  endsOn,
  action: cancel = cancelMembershipAction,
  who = "member",
}: {
  membershipId: string;
  planName: string;
  endsOn: string | null;
  action?: (previous: CancelMembershipState, formData: FormData) => Promise<CancelMembershipState>;
  who?: "member" | "owner";
}) {
  const [state, action, pending] = useActionState(cancel, { status: "idle", message: "" } as CancelMembershipState);
  const your = who === "member" ? "your" : "the member's";
  const [asking, setAsking] = useState(false);
  if (state.status === "cancelled") {
    return (
      <div className="flash flash-success" role="status">
        {state.message}
      </div>
    );
  }
  return (
    <form action={action} className="membership-cancel">
      <input type="hidden" name="membershipId" value={membershipId} />
      {asking ? (
        <p className="editor-confirm">
          Cancel {planName}{who === "owner" ? " for the member" : ""}? No more monthly payments will be taken
          {endsOn ? `, and the month paid for runs until ${endsOn}` : ""}. The hours left on {your} code stay{" "}
          {who === "member" ? "yours" : "theirs"}.{" "}
          <button type="submit" className="btn btn-outline btn-small" disabled={pending}>
            Yes, cancel it
          </button>{" "}
          <button type="button" className="btn btn-outline btn-small" onClick={() => setAsking(false)}>
            Keep it
          </button>
        </p>
      ) : (
        <button type="button" className="btn btn-outline btn-small" onClick={() => setAsking(true)}>
          Cancel membership
        </button>
      )}
      {state.status === "error" && (
        <div className="flash flash-error" role="alert">
          {state.message}
        </div>
      )}
    </form>
  );
}
