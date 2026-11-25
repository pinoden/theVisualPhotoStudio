import { sessionsOf } from "@/lib/domain/services";
import { bookingLengths, multiStudioOffer, petPolicy } from "@/lib/catalog-view";
import { noticeHours } from "@/lib/domain/availability";
import { formatCents } from "@/lib/domain/pricing";
import { count, hoursInWords, hoursWithDays, listInWords } from "@/lib/words";
import type { Catalog } from "@/server/catalog";
import type { Business } from "./frame";

/**
 * Live values: facts from the settings, the prices and the studio's details
 * that the text of a page can name, so that the text cannot disagree with
 * what the site does. Written in a page's text as `{refund window}`; the
 * website shows "7 days", and shows the new number the moment an owner
 * changes the setting. In the editor a live value shows as its name.
 *
 * A name that is not one of these is left as it was typed.
 */
export interface LiveValue {
  /** What is typed between the braces. Small letters and spaces. */
  name: string;
  /** What it is, for the list beside the editor. */
  about: string;
  value: string;
}

export function liveValues(catalog: Catalog, business: Business): LiveValue[] {
  const s = catalog.settings;
  const pets = petPolicy(catalog);
  const sessions = sessionsOf(catalog.photoPackages, "photography").map((entry) => entry.priceCents);
  const value = (name: string, about: string, text: string): LiveValue => ({ name, about, value: text });
  return [
    value("studio name", "The studio's name, as the header and footer have it", business.name),
    value("address", "The studio's address, on one line", `${business.addressLine1}, ${business.addressLine2}`),
    value("phone", "The studio's phone number", business.phone),
    value("minimum notice", "How long before the start a booking can be made at the latest", hoursWithDays(s.minLeadHours)),
    value("booking horizon", "How far ahead bookings open", count(s.maxAdvanceDays, "day")),
    value("refund window", "How long before the start a cancellation is refunded", hoursInWords(s.refundWindowHours)),
    value("refund window with hours", "The same, with the hours: 7 days (168 hours)", hoursWithDays(s.refundWindowHours)),
    value("refund fee", "The processing fee kept from a refund", `${s.refundFeePercent}%`),
    value("reschedule cutoff", "How long before the start a booking can still be moved", hoursInWords(s.rescheduleCutoffHours)),
    value("reschedules allowed", "How often one booking can be moved free of charge", s.maxReschedules === 1 ? "once" : `up to ${s.maxReschedules} times`),
    value("reschedule fee", "What moving a booking again costs, after the free times", formatCents(s.rescheduleFeeCents)),
    value("reschedule code valid", "How long a reschedule code can be used", count(s.creditValidDays, "day")),
    value("member hours back", "How long before the start a cancelled booking gives its membership hours back", hoursInWords(s.memberReturnHours)),
    value("free hour visits", "Visits, on separate days, that earn a free hour", count(s.loyaltyVisits, "time")),
    value("free hour valid", "How long a free hour can be used", count(s.loyaltyValidDays, "day")),
    value("photography notice", "How far ahead a photography session is booked at the latest", hoursInWords(noticeHours(s, true))),
    value("photography refund window", "How long before a photography session a cancellation is refunded", hoursInWords(s.photoRefundWindowHours)),
    value("sessions from", "The lowest price of a photography session", sessions.length > 0 ? formatCents(Math.min(...sessions)) : ""),
    value(
      "pet fee",
      "The fee for bringing a pet: one amount, or each studio's when they differ",
      pets.fees.length === 0 ? "" : pets.oneFee ? formatCents(pets.fees[0].cents) : listInWords(pets.fees.map((fee) => `${formatCents(fee.cents)} for ${fee.studio}`)),
    ),
    value("pet studios", "The studios that welcome pets", listInWords(pets.studios)),
    value("included guests", "The guests each studio's price includes", listInWords(catalog.studios.map((studio) => `${studio.name} up to ${studio.includedGuests}`))),
    value("booking lengths", "How long a studio or a bundle can be booked for: 1 to 10 hours", bookingLengths(catalog)),
    value("several studios offer", "The discount for booking several studios together", multiStudioOffer(catalog)),
  ];
}

/** `{name}`: small letters and spaces between braces. */
const TOKEN = /\{([a-z][a-z ]{1,40}[a-z])\}/g;

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Put the live values into text. With `html`, the values are escaped for HTML. A name that is not known stays as it was. */
export function fillLiveValues(text: string, values: Record<string, string>, html = false): string {
  return text.replace(TOKEN, (whole, name: string) => (Object.hasOwn(values, name) ? (html ? escapeHtml(values[name]) : values[name]) : whole));
}
