"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { isSettableLabel, LABEL_BLOCK_TEXT, LABEL_TEXT } from "@/lib/domain/labels";
import { formText } from "@/lib/parse";
import { setLabel } from "@/server/appointments";
import { requireStaff } from "@/server/session";

/**
 * What both levels of the admin can do with one appointment. Every action
 * starts with `requireStaff`, and the service checks the viewer's abilities
 * and days again: a server action can be called directly.
 */

/** Where to go back to: the appointment itself, the day sheet or the calendar. Nothing else is followed. */
function backTo(formData: FormData, ref: string): string {
  const back = formText(formData.get("back"));
  if (/^\/(staff|admin\/calendar|admin\/bookings)(\?[A-Za-z0-9=&%_.:-]*)?$/.test(back)) return back;
  return /^VS-[0-9A-Z]{6}$/.test(ref) ? `/admin/appointments/${ref}` : "/staff";
}

const withMessage = (path: string, kind: "notice" | "error", text: string) =>
  `${path}${path.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(text)}`;

export async function setLabelAction(formData: FormData): Promise<void> {
  const ref = formText(formData.get("ref"));
  const back = backTo(formData, ref);
  const viewer = await requireStaff(back);
  const label = formData.get("label");
  if (!isSettableLabel(label)) redirect(withMessage(back, "error", "Choose a label."));

  const result = await setLabel(await getDb(), viewer, ref, label, new Date());
  if (result.ok) redirect(withMessage(back, "notice", `Marked ${LABEL_TEXT[result.label]}.`));
  const why =
    result.reason === "forbidden"
      ? "You cannot change the label of that booking."
      : result.reason === "not_found"
        ? "Booking not found."
        : LABEL_BLOCK_TEXT[result.reason];
  redirect(withMessage(back, "error", why));
}
