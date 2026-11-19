import { z } from "zod";
import type { DbLike } from "@/db/client";
import { CONTACT_LIMITS, CONTACT_TOPICS, type ContactTopic } from "@/lib/contact";
import { formText } from "@/lib/parse";
import { contactMessageEmail, queueEmail } from "./email";

/**
 * Messages from the contact page. A message is not stored anywhere of its
 * own: it becomes one queued email to the owner, with the visitor's address
 * as the reply address. Nothing is ever emailed to the address a visitor
 * typed, so the form cannot be used to send mail to strangers.
 */

export type ContactField = "name" | "email" | "topic" | "message";

export type ContactResult =
  | { ok: true }
  | { ok: false; code: "invalid"; fields: Partial<Record<ContactField, string>> }
  /** Nobody is configured to receive messages (no owner address). */
  | { ok: false; code: "unavailable" }
  | { ok: false; code: "too_many" };

export interface ContactDeps {
  /** Who receives messages. Null when no owner address is configured. */
  ownerEmail: string | null;
  /** Asked once for each message that would be sent; false refuses it. For rate limiting. */
  allowSend?: () => boolean | Promise<boolean>;
}

const TOPIC_KEYS = Object.keys(CONTACT_TOPICS) as [ContactTopic, ...ContactTopic[]];

const contactInput = z.object({
  // One line: the name goes into the email's subject.
  name: z
    .string()
    .transform((value) => formText(value).replace(/\s+/g, " "))
    .pipe(z.string().min(1).max(CONTACT_LIMITS.name)),
  email: z.string().trim().toLowerCase().max(CONTACT_LIMITS.email).pipe(z.email()),
  topic: z.enum(TOPIC_KEYS),
  // formText first: the browser sends a line break as two characters and the box counts it as one.
  message: z.string().transform(formText).pipe(z.string().min(1).max(CONTACT_LIMITS.message)),
});

const FIELD_PROBLEMS: Record<ContactField, string> = {
  name: "Please enter your name.",
  email: "Please enter a valid email address.",
  topic: "Please choose a topic.",
  message: `Please write a message of up to ${CONTACT_LIMITS.message.toLocaleString("en-US")} characters.`,
};

/**
 * Check a message and queue it for the owner.
 *
 * `trap` is a field people never see. Programs that fill in every field give
 * themselves away by filling it; their message is dropped, and they are told
 * it was sent so they have nothing to adapt to.
 */
export async function sendContactMessage(
  db: DbLike,
  input: { name?: unknown; email?: unknown; topic?: unknown; message?: unknown; trap?: unknown },
  deps: ContactDeps,
): Promise<ContactResult> {
  if (typeof input.trap === "string" && input.trap.trim() !== "") return { ok: true };

  const parsed = contactInput.safeParse(input);
  if (!parsed.success) {
    const fields: Partial<Record<ContactField, string>> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as ContactField;
      if (field in FIELD_PROBLEMS) fields[field] = FIELD_PROBLEMS[field];
    }
    return { ok: false, code: "invalid", fields };
  }

  if (!deps.ownerEmail) return { ok: false, code: "unavailable" };
  if (deps.allowSend && !(await deps.allowSend())) return { ok: false, code: "too_many" };

  const { name, email, topic, message } = parsed.data;
  await queueEmail(db, contactMessageEmail({ to: deps.ownerEmail, name, email, topic: CONTACT_TOPICS[topic], message }));
  return { ok: true };
}
