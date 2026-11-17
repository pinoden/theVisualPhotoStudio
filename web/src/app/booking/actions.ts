"use server";

import { refresh } from "next/cache";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/domain/pricing";
import { UNSEEN_LINK } from "@/server/email";
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
  const seen = formData.get("seen");
  const result = await cancelBooking(await getDb(), String(formData.get("ref") ?? ""), actor, await manageDeps(), typeof seen === "string" ? seen : undefined);
  // Refused because something changed since the page was drawn: it is drawn again, with what can be done now. Not
  // when the booking has ended meanwhile: the page drawn again would have nowhere to say why nothing was done.
  if (!result.ok) {
    if (result.code !== "not_confirmed") refresh();
    return { status: "error", message: result.message };
  }
  flushEmailsSoon();
  if (!formData.get("keepInPlace")) refresh();
  // The whole outcome, as the client was told it before confirming. A card refund that did not go through is not "on its way".
  const late = result.refund === "pending" ? " The refund has not reached your card yet: it is tried again by itself, and the studio has been told." : "";
  return { status: "cancelled", message: `Your booking is cancelled. ${result.message}${late}` };
}

export async function rescheduleBookingAction(_previous: ManageState, formData: FormData): Promise<ManageState> {
  const actor = await actorFrom(formData);
  if (!actor) return SIGNED_OUT;
  const seen = formData.get("seen");
  const result = await requestRescheduleCode(await getDb(), String(formData.get("ref") ?? ""), actor, await manageDeps(), typeof seen === "string" ? seen : undefined);
  if (!result.ok) {
    if (result.code !== "not_confirmed") refresh();
    return { status: "error", message: result.message };
  }
  flushEmailsSoon();
  if (!formData.get("keepInPlace")) refresh();
  return {
    status: "rescheduled",
    code: result.code,
    message: `Your booking was released. Your code is worth ${formatCents(result.valueCents)} and is valid until ${formatInstant(result.expiresAt)}. We also emailed it to you.${
      result.unseenLink ? ` ${UNSEEN_LINK}` : ""
    }`,
  };
}
