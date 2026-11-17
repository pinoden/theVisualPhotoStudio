"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { isSettableLabel, LABEL_BLOCK_TEXT, LABEL_TEXT } from "@/lib/domain/labels";
import { formatCents } from "@/lib/domain/pricing";
import { isIsoDate } from "@/lib/domain/time";
import { dollarsToCents, formText, intInRange } from "@/lib/parse";
import { createAdminBooking, moveBooking, setLabel } from "@/server/appointments";
import { cancelPayLink, checkBookingPayLink, sendPayLink } from "@/server/pay-links";
import { givePetFeeCredit } from "@/server/pet-fee";
import { flushEmailsSoon, payLinkDeps, siteUrl } from "@/server/runtime";
import { requireOwner, requireStaff } from "@/server/session";
import { recordHandRefund, recordStudioPayment, voidStudioPayment } from "@/server/studio-payments";
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
      // Each add-on once, as on the booking screen; one that does not apply to the studios is refused by the price.
      addons: [...new Set(formData.getAll("addon").filter((value): value is string => typeof value === "string"))].map((addonId) => ({ addonId, quantity: 1 })),
      // A reward or credit of the client's, used on their behalf: it is checked and spent as at checkout.
      promoCode: formText(formData.get("code")) || undefined,
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

// ── Money taken at the studio ────────────────────────────────────────────────

/** The appointment's own page, for the actions that only make sense there. */
function appointmentPage(ref: string): string {
  return /^VS-[0-9A-Z]{6}$/.test(ref) ? `/admin/appointments/${ref}` : "/admin/calendar";
}

/** "Mark as paid": record a payment taken at the studio. The service checks who may, and how much is owed. */
export async function recordPaymentAction(formData: FormData): Promise<void> {
  const ref = formText(formData.get("ref"));
  const page = appointmentPage(ref);
  const viewer = await requireStaff(page);
  const amountCents = dollarsToCents(formText(formData.get("amount")));
  if (amountCents === null) redirect(withMessage(page, "error", "Enter the amount that was paid, for example 88 or 88.50."));

  const result = await recordStudioPayment(
    await getDb(),
    viewer,
    ref,
    { amountCents, method: formText(formData.get("method")), note: formText(formData.get("note")) },
    new Date(),
  );
  if (!result.ok) redirect(withMessage(page, "error", result.message));
  flushEmailsSoon();
  redirect(
    withMessage(
      page,
      "notice",
      `${formatCents(result.amountCents)} recorded. ${
        result.dueCents > 0 ? `${formatCents(result.dueCents)} is still to pay.` : "The booking is paid in full."
      } The client has been emailed a confirmation.`,
    ),
  );
}

/** Take back a payment recorded by mistake. Owners only. */
export async function voidPaymentAction(formData: FormData): Promise<void> {
  const page = appointmentPage(formText(formData.get("ref")));
  const viewer = await requireOwner(page);
  const result = await voidStudioPayment(await getDb(), viewer, formText(formData.get("paymentId")), formText(formData.get("reason")), new Date());
  if (!result.ok) redirect(withMessage(page, "error", result.message));
  redirect(withMessage(page, "notice", "The payment record was taken back. The booking owes that amount again."));
}

/** Record a refund the studio gave by hand. Owners only. Nothing is sent anywhere. */
export async function handRefundAction(formData: FormData): Promise<void> {
  const page = appointmentPage(formText(formData.get("ref")));
  const viewer = await requireOwner(page);
  const amountCents = dollarsToCents(formText(formData.get("amount")));
  if (amountCents === null) redirect(withMessage(page, "error", "Enter the amount that was given back, for example 25 or 25.50."));
  const result = await recordHandRefund(
    await getDb(),
    viewer,
    formText(formData.get("paymentId")),
    { amountCents, note: formText(formData.get("note")) },
    new Date(),
  );
  if (!result.ok) redirect(withMessage(page, "error", result.message));
  redirect(withMessage(page, "notice", `Refund of ${formatCents(amountCents)} recorded. Nothing was sent: this records what you gave back by hand.`));
}

/** The pet did not come: return the pet fee as studio credit. Owners only. */
export async function petCreditAction(formData: FormData): Promise<void> {
  const ref = formText(formData.get("ref"));
  const page = appointmentPage(ref);
  const viewer = await requireOwner(page);
  const result = await givePetFeeCredit(await getDb(), viewer, ref, { now: new Date(), baseUrl: await siteUrl() });
  if (!result.ok) redirect(withMessage(page, "error", result.message));
  flushEmailsSoon();
  redirect(withMessage(page, "notice", `The pet fee of ${formatCents(result.cents)} is now studio credit. The client has been emailed the code ${result.code}.`));
}

// ── A payment link for what a booking still owes ─────────────────────────────

/** Email the client a link to pay by card. Pressed again while the link is open, it emails the same link again. */
export async function sendPayLinkAction(formData: FormData): Promise<void> {
  const ref = formText(formData.get("ref"));
  const page = appointmentPage(ref);
  const viewer = await requireStaff(page);
  const result = await sendPayLink(await getDb(), viewer, ref, await payLinkDeps());
  if (!result.ok) redirect(withMessage(page, "error", result.message));
  flushEmailsSoon();
  redirect(
    withMessage(
      page,
      "notice",
      result.again
        ? `The payment link for ${formatCents(result.amountCents)} was emailed to the client again.`
        : `A payment link for ${formatCents(result.amountCents)} was emailed to the client. When they have paid, the payment appears here by itself.`,
    ),
  );
}

/** Ask the card processor now whether the link was paid. */
export async function checkPayLinkAction(formData: FormData): Promise<void> {
  const ref = formText(formData.get("ref"));
  const page = appointmentPage(ref);
  const viewer = await requireStaff(page);
  const result = await checkBookingPayLink(await getDb(), viewer, ref, await payLinkDeps());
  if (!result.ok) redirect(withMessage(page, "error", result.message));
  flushEmailsSoon();
  redirect(
    withMessage(
      page,
      "notice",
      result.status === "paid"
        ? result.late
          ? "The client paid through the link after the booking ended: the payment is refunded to the card in full, and the client is told."
          : "The client has paid through the link. The payment is recorded."
        : result.status === "cancelled"
          ? "The link was cancelled at the card processor."
          : "The link has not been paid yet.",
    ),
  );
}

/** Withdraw the link, for example to record cash instead. A link that turns out to be paid is recorded as paid. */
export async function cancelPayLinkAction(formData: FormData): Promise<void> {
  const ref = formText(formData.get("ref"));
  const page = appointmentPage(ref);
  const viewer = await requireStaff(page);
  const result = await cancelPayLink(await getDb(), viewer, ref, await payLinkDeps());
  if (!result.ok) redirect(withMessage(page, "error", result.message));
  flushEmailsSoon();
  redirect(
    withMessage(
      page,
      "notice",
      result.outcome === "was_paid"
        ? "The client had already paid through the link: the payment is recorded, and nothing was cancelled."
        : "The payment link was cancelled. It can no longer be paid.",
    ),
  );
}
