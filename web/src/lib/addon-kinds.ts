/**
 * What an add-on is for. The owner picks it under Studios & add-ons. The
 * guest information page reads it to answer whether larger groups and pets
 * can be booked, so those answers follow what is offered and not what an
 * add-on happens to be called.
 */
export const ADDON_KINDS = {
  people: "More people than the price includes",
  pet: "Bringing a pet",
  other: "Something else",
} as const;

export type AddonKind = keyof typeof ADDON_KINDS;

export function isAddonKind(value: unknown): value is AddonKind {
  return typeof value === "string" && Object.hasOwn(ADDON_KINDS, value);
}
