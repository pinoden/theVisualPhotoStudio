/**
 * How money was taken at the studio, for a payment an administrator records
 * by hand ("mark as paid"). A card charged through the site has no method:
 * its payment row names the processor instead.
 */
export const PAYMENT_METHODS = {
  cash: "Cash",
  card: "Card, on the studio's own reader",
  transfer: "Bank transfer or payment app",
  other: "Something else",
} as const;

export type PaymentMethod = keyof typeof PAYMENT_METHODS;

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === "string" && Object.hasOwn(PAYMENT_METHODS, value);
}

/** The `provider` of a payment recorded by hand. The site cannot refund it: the money never passed through it. */
export const MANUAL_PROVIDER = "manual";
