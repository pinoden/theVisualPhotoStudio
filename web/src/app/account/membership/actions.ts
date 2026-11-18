"use server";

import { refresh } from "next/cache";
import { getDb } from "@/db/client";
import { cancelMembership } from "@/server/memberships";
import { resolvePayments } from "@/server/payments";
import { flushEmailsSoon, siteUrl } from "@/server/runtime";
import { getCurrentUser } from "@/server/session";

export interface CancelMembershipState {
  status: "idle" | "cancelled" | "error";
  message: string;
}

/** A member cancels their membership in their account (`cancelMembership`). */
export async function cancelMembershipAction(_previous: CancelMembershipState, formData: FormData): Promise<CancelMembershipState> {
  const user = await getCurrentUser();
  if (!user) return { status: "error", message: "Please sign in again." };
  const result = await cancelMembership(await getDb(), { email: user.email, role: "customer" }, String(formData.get("membershipId") ?? ""), {
    now: new Date(),
    payments: resolvePayments().provider,
    baseUrl: await siteUrl(),
  });
  if (!result.ok) return { status: "error", message: result.message };
  flushEmailsSoon();
  refresh();
  return { status: "cancelled", message: "Your membership is cancelled. No more monthly payments will be taken, and your hours stay on your code." };
}
