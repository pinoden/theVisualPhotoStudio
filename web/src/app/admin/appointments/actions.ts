"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { isSettableLabel, LABEL_BLOCK_TEXT, LABEL_TEXT } from "@/lib/domain/labels";
import { isIsoDate } from "@/lib/domain/time";
import { formText, intInRange } from "@/lib/parse";
import { createAdminBooking, moveBooking, setLabel } from "@/server/appointments";
import { flushEmailsSoon, siteUrl } from "@/server/runtime";
import { requireStaff } from "@/server/session";
import { formatInstant } from "@/server/tz";

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

/** Move a booking to a new time. `moveBooking` checks the viewer, the booking and the new time itself. */
export async function moveBookingAction(formData: FormData): Promise<void> {
  const ref = formText(formData.get("ref"));
  const page = /^VS-[0-9A-Z]{6}$/.test(ref) ? `/admin/appointments/${ref}` : "/admin/calendar";
  const viewer = await requireStaff(page);
  const date = formText(formData.get("date"));
  // After a refusal the form comes back on the date that was being tried.
  const retry = isIsoDate(date) ? `${page}?move=${date}` : page;
  const startMinute = intInRange(formText(formData.get("startMinute")), 0, 1439);
  if (startMinute === null) redirect(withMessage(retry, "error", "Choose a start time."));

  const result = await moveBooking(
    await getDb(),
    viewer,
    ref,
    { date, startMinute, countsAsClientMove: formData.get("countsAsClientMove") !== null },
    new Date(),
  );
  if (!result.ok) redirect(withMessage(retry, "error", result.message));
  flushEmailsSoon();
  redirect(withMessage(page, "notice", `Moved to ${formatInstant(result.startAt)}. The client has been emailed.`));
}

/** Make a booking for a client from the admin. Nothing is charged online. */
export async function createAdminBookingAction(formData: FormData): Promise<void> {
  const viewer = await requireStaff("/admin/calendar/new");
  const studioIds = formData.getAll("studio").filter((value): value is string => typeof value === "string");
  const date = formText(formData.get("date"));
  const durationMinutes = intInRange(formText(formData.get("duration")), 15, 1440);
  const startMinute = intInRange(formText(formData.get("startMinute")), 0, 1439);

  const again = new URLSearchParams();
  for (const id of studioIds) again.append("studio", id);
  again.set("date", date);
  if (durationMinutes !== null) again.set("duration", String(durationMinutes));
  const form = `/admin/calendar/new?${again}`;
  if (durationMinutes === null || startMinute === null) redirect(withMessage(form, "error", "Choose a length and a start time."));

  const result = await createAdminBooking(
    await getDb(),
    viewer,
    {
      studioIds,
      date,
      startMinute,
      durationMinutes,
      customer: {
        name: formText(formData.get("name")),
        email: formText(formData.get("email")),
        phone: formText(formData.get("phone")),
      },
      notes: formText(formData.get("notes")),
    },
    { now: new Date(), baseUrl: await siteUrl() },
  );
  if (!result.ok) redirect(withMessage(form, "error", result.message));
  flushEmailsSoon();
  redirect(
    withMessage(
      `/admin/appointments/${result.ref}`,
      "notice",
      "Booked. The client has been emailed their confirmation. Nothing was charged: the price is paid at the studio.",
    ),
  );
}
