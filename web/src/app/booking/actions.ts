"use server";

import { refresh } from "next/cache";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/domain/pricing";
import { cancelBooking, requestRescheduleCode, type Actor } from "@/server/manage";
import { flushEmailsSoon, manageDeps } from "@/server/runtime";
import { getCurrentUser } from "@/server/session";
import { formatInstant } from "@/server/tz";

export interface ManageState {
  status: "idle" | "cancelled" | "rescheduled" | "error";
  message: string;
  /** The reschedule code, shown once on screen as well as emailed. */
  code?: string;
}

/**
 * Who is acting: the holder of the booking's secret link, or the signed-in
 * customer. The services check the actor against the booking again.
 */
async function actorFrom(formData: FormData): Promise<Actor | null> {
  const token = formData.get("token");
  if (typeof token === "string" && token !== "") return { kind: "token", token };
  const user = await getCurrentUser();
  return user ? { kind: "customer", email: user.email } : null;
}

const SIGNED_OUT: ManageState = { status: "error", message: "Please sign in again, or use the link from your confirmation email." };

export async function cancelBookingAction(_previous: ManageState, formData: FormData): Promise<ManageState> {
  const actor = await actorFrom(formData);
  if (!actor) return SIGNED_OUT;
  const result = await cancelBooking(await getDb(), String(formData.get("ref") ?? ""), actor, await manageDeps());
  if (!result.ok) return { status: "error", message: result.message };
  flushEmailsSoon();
  if (!formData.get("keepInPlace")) refresh();
  // The pet fee is never sent back to the card: when a refund is due it comes back as a code for studio credit.
  const credit =
    result.creditCents > 0
      ? ` The pet fee of ${formatCents(result.creditCents)} is returned as studio credit: we have emailed you the code.`
      : "";
  return {
    status: "cancelled",
    message:
      result.refund === "none"
        ? `Your booking is cancelled. ${result.message}`
        : `Your booking is cancelled. A refund of ${formatCents(result.refundCents)} is on its way to your card.${credit}`,
  };
}

export async function rescheduleBookingAction(_previous: ManageState, formData: FormData): Promise<ManageState> {
  const actor = await actorFrom(formData);
  if (!actor) return SIGNED_OUT;
  const result = await requestRescheduleCode(await getDb(), String(formData.get("ref") ?? ""), actor, await manageDeps());
  if (!result.ok) return { status: "error", message: result.message };
  flushEmailsSoon();
  if (!formData.get("keepInPlace")) refresh();
  return {
    status: "rescheduled",
    code: result.code,
    message: `Your booking was released. Your code is worth ${formatCents(result.valueCents)} and is valid until ${formatInstant(result.expiresAt)}. We also emailed it to you.`,
  };
}
