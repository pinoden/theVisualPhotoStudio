"use server";

import { headers } from "next/headers";
import { getDb } from "@/db/client";
import { CONTACT_LIMITS } from "@/lib/contact";
import { formText } from "@/lib/parse";
import { SITE } from "@/lib/site";
import { sendContactMessage, type ContactField } from "@/server/contact";
import { RateLimiter } from "@/server/rate-limit";
import { flushEmailsSoon, ownerNotifyEmail } from "@/server/runtime";

export interface ContactState {
  status: "idle" | "sent" | "error";
  error: string;
  fields: Partial<Record<ContactField, string>>;
  /** What the visitor typed, handed back so a refused message is not lost. */
  values: { name: string; email: string; topic: string; message: string };
  /** Counts answers, so the form can redraw its fields with the values above. */
  attempt: number;
}

const EMPTY = { name: "", email: "", topic: "", message: "" };

// Five messages in ten minutes from one address. Kept in memory, like the booking limit.
const limiter = new RateLimiter({ windowMs: 10 * 60_000, maxRequests: 5 });

// Line breaks are made single before the cut, as the box counted them, so nothing the box accepted is lost.
// One character over the limit is kept so an over-long value is refused, not silently cut.
const field = (formData: FormData, name: string, limit: number) => formText(formData.get(name)).slice(0, limit + 1);

export async function sendMessageAction(previous: ContactState, formData: FormData): Promise<ContactState> {
  const attempt = previous.attempt + 1;
  if (formData.get("intent") === "restart") return { status: "idle", error: "", fields: {}, values: EMPTY, attempt };

  const values = {
    name: field(formData, "name", CONTACT_LIMITS.name),
    email: field(formData, "email", CONTACT_LIMITS.email),
    topic: field(formData, "topic", 40),
    message: field(formData, "message", CONTACT_LIMITS.message),
  };
  const address = (await headers()).get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

  const result = await sendContactMessage(
    await getDb(),
    { ...values, trap: formData.get("leave_blank") },
    { ownerEmail: ownerNotifyEmail(), allowSend: () => limiter.check(address).allowed },
  );

  if (result.ok) {
    flushEmailsSoon();
    return { status: "sent", error: "", fields: {}, values: EMPTY, attempt };
  }
  if (result.code === "invalid") {
    return { status: "error", error: "Please check the marked fields.", fields: result.fields, values, attempt };
  }
  const error =
    result.code === "too_many"
      ? `You have sent several messages in a short time. Please wait a few minutes, or call us at ${SITE.phoneDisplay}.`
      : `Sorry, messages cannot be sent from this page right now. Please call us at ${SITE.phoneDisplay}.`;
  return { status: "error", error, fields: {}, values, attempt };
}
