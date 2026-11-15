/** What a visitor can write to the studio about. The key travels in the form; the label is shown. */
export const CONTACT_TOPICS = {
  rental: "Studio rental",
  photography: "Photography session",
  membership: "Membership",
  booking: "My booking",
  other: "Something else",
} as const;

export type ContactTopic = keyof typeof CONTACT_TOPICS;

export const CONTACT_LIMITS = { name: 100, email: 200, message: 4000 } as const;
