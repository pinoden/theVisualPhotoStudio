/**
 * How money was taken at the studio, for a payment an administrator records
 * by hand ("mark as paid"). A card charged through the site has no method:
 * its payment row names the processor instead.
 *
 * `acuity` is money paid for an appointment in Acuity Scheduling, the old
 * website's booking system, before the appointment came here: the import
 * records it (src/server/acuity-import.ts), and an administrator can too, for
 * an appointment entered by hand. It was not paid at the studio.
 */
export const PAYMENT_METHODS = {
  cash: "Cash",
  card: "Card, on the studio's own reader",
  transfer: "Bank transfer or payment app",
  other: "Something else",
  acuity: "Through Acuity, before this website",
} as const;

export type PaymentMethod = keyof typeof PAYMENT_METHODS;

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === "string" && Object.hasOwn(PAYMENT_METHODS, value);
}

/** The method of money paid in Acuity before its appointment was imported. */
export const ACUITY_METHOD = "acuity" satisfies PaymentMethod;

/** How a payment recorded by hand was made, as a receipt says it. */
export function handPaymentWords(method: string | null): string {
  if (method === ACUITY_METHOD) return PAYMENT_METHODS.acuity;
  return `At the studio: ${isPaymentMethod(method) ? PAYMENT_METHODS[method].toLowerCase() : "payment"}`;
}

/** The `provider` of a payment recorded by hand. The site cannot refund it: the money never passed through it. */
export const MANUAL_PROVIDER = "manual";

/**
 * Where a booking's money recorded by hand was paid, in words: "at the studio", "through Acuity" (an appointment
 * imported from the old site, `ACUITY_METHOD`), or both. What the studio gives back by hand is described by it.
 */
export function handPaidPlace(paid: { atStudio: boolean; throughAcuity: boolean }): string {
  if (paid.throughAcuity) return paid.atStudio ? "at the studio and through Acuity" : "through Acuity";
  return "at the studio";
}
