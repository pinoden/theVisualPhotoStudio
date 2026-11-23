/**
 * The sessions the studio sells with one of its own people, the studio included (the owner's admin brief of
 * 2026-11-22, item 11, and the owner's answer of 2026-11-23: Content Creation is "when I'm creating reels/stories for
 * a customer using iPhone, that's similar to a session with a photographer"; question 69 in ProjectLibrary.md).
 * Each has its person, with their working hours and days off, and its sessions on sale. What a session is otherwise
 * (its notice, its refund window, the codes and forms for sessions, no loyalty stamp) is the same for both.
 */
export const SERVICES = ["photography", "content"] as const;
export type Service = (typeof SERVICES)[number];

/** The booking pages: the studios', and each service's. */
export type BookPath = "/book" | "/book/photography" | "/book/content";

export const isService = (value: unknown): value is Service => typeof value === "string" && (SERVICES as readonly string[]).includes(value);

export interface ServiceWords {
  /** "Photography", "Content Creation": the admin page's and the type's name. */
  name: string;
  /** "photography session", in a sentence. */
  session: string;
  /** "Photography session", at the start of one. */
  Session: string;
  /** "photographer", "content creator". */
  person: string;
  /** "with our in-house photographer". */
  withPerson: string;
  /** The booking page's heading and the button that leads there. */
  book: string;
  bookPath: "/book/photography" | "/book/content";
  adminPath: "/admin/photography" | "/admin/content";
}

export const SERVICE_WORDS: Record<Service, ServiceWords> = {
  photography: {
    name: "Photography",
    session: "photography session",
    Session: "Photography session",
    person: "photographer",
    withPerson: "with our in-house photographer",
    book: "Book a Photographer",
    bookPath: "/book/photography",
    adminPath: "/admin/photography",
  },
  content: {
    name: "Content Creation",
    session: "content creation session",
    Session: "Content creation session",
    person: "content creator",
    withPerson: "with our in-house content creator",
    book: "Book Content Creation",
    bookPath: "/book/content",
    adminPath: "/admin/content",
  },
};

/** The sessions of one service among those on sale. */
export function sessionsOf<T extends { service: Service }>(sessions: readonly T[], service: Service): T[] {
  return sessions.filter((session) => session.service === service);
}
