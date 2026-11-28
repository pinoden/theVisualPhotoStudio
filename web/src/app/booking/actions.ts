"use server";

import { refresh } from "next/cache";
import type { BookPath } from "@/lib/domain/services";
import { getDb } from "@/db/client";
import { WEEKDAYS_ONLY_TEXT } from "@/lib/domain/policy";
import { formatCents } from "@/lib/domain/pricing";
import { askStudioToMove, cancelBooking, requestRescheduleCode, type Actor } from "@/server/manage";
import { flushEmailsSoon, manageDeps } from "@/server/runtime";
import { getCurrentUser } from "@/server/session";
import { formatInstant } from "@/server/tz";
import { formText } from "@/lib/parse";

export interface ManageState {
  /** `waiting`: the cancellation or release was asked for, and waits for the card processor (`waitToEnd` in manage.ts). */
  status: "idle" | "cancelled" | "rescheduled" | "requested" | "waiting" | "error";
  message: string;
  /** The reschedule code, shown once on screen as well as emailed. */
  code?: string;
  bookPath?: BookPath;
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

/**
 * A cancellation or release that waits for the card processor (`waitToEnd` in manage.ts): the owners' notice goes, and
 * the page is drawn again with the request in place of the choices.
 */
function waitingState(message: string, formData: FormData): ManageState {
  flushEmailsSoon();
  if (!formData.get("keepInPlace")) refresh();
  return { status: "waiting", message };
}

export async function cancelBookingAction(_previous: ManageState, formData: FormData): Promise<ManageState> {
  const actor = await actorFrom(formData);
  if (!actor) return SIGNED_OUT;
  const seen = formData.get("seen");
  const result = await cancelBooking(await getDb(), String(formData.get("ref") ?? ""), actor, await manageDeps(), typeof seen === "string" ? seen : undefined);
  if (!result.ok && result.code === "waiting") return waitingState(result.message, formData);
  // Refused because something changed since the page was drawn: it is drawn again, with what can be done now. Not
  // when the booking has ended meanwhile: the page drawn again would have nowhere to say why nothing was done.
  if (!result.ok) {
    if (result.code !== "not_confirmed") refresh();
    return { status: "error", message: result.message };
  }
  flushEmailsSoon();
  if (!formData.get("keepInPlace")) refresh();
  // The whole outcome, as the client was told it before confirming. A card refund that did not go through is not "on its way".
  const late =
    result.refund === "pending" || result.refund === "waiting"
      ? " The refund has not reached your card yet: the studio has been told, and will see that it does."
      : "";
  return { status: "cancelled", message: `Your booking is cancelled. ${result.message}${late}` };
}

export async function rescheduleBookingAction(_previous: ManageState, formData: FormData): Promise<ManageState> {
  const actor = await actorFrom(formData);
  if (!actor) return SIGNED_OUT;
  const seen = formData.get("seen");
  const result = await requestRescheduleCode(await getDb(), String(formData.get("ref") ?? ""), actor, await manageDeps(), typeof seen === "string" ? seen : undefined);
  if (!result.ok && result.code === "waiting") return waitingState(result.message, formData);
  if (!result.ok) {
    if (result.code !== "not_confirmed") refresh();
    return { status: "error", message: result.message };
  }
  flushEmailsSoon();
  if (!formData.get("keepInPlace")) refresh();
  return {
    status: "rescheduled",
    code: result.code,
    bookPath: result.bookPath,
    message: `Your booking was released. Your code is worth ${formatCents(result.valueCents)} and is valid until ${formatInstant(result.expiresAt)}.${result.weekdaysOnly ? ` ${WEEKDAYS_ONLY_TEXT}` : ""} We also emailed it to you.`,
  };
}

/** The client asks the studio to move the booking (question 20): it keeps its time until the studio moves it. */
export async function askStudioToMoveAction(_previous: ManageState, formData: FormData): Promise<ManageState> {
  const actor = await actorFrom(formData);
  if (!actor) return SIGNED_OUT;
  // As every form's text: a browser sends each line break as \r\n, which counted twice refused a message the box allowed
  // (the tester's finding of 2026-11-18).
  const result = await askStudioToMove(await getDb(), formText(formData.get("ref")), actor, formText(formData.get("message")), await manageDeps());
  if (!result.ok) {
    if (result.code === "already_asked") refresh();
    return { status: "error", message: result.message };
  }
  flushEmailsSoon();
  if (!formData.get("keepInPlace")) refresh();
  return {
    status: "requested",
    message: "Your request was sent. The studio will contact you to agree a new time; until then your booking stays as it is. We emailed you a copy.",
  };
}
