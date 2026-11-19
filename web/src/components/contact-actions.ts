"use server";

import { headers } from "next/headers";
import { getDb } from "@/db/client";
import { CONTACT_LIMITS } from "@/lib/contact";
import { formText } from "@/lib/parse";
import { sendContactMessage, type ContactField } from "@/server/contact";
import { clientAddress, limitRate } from "@/server/rate-limit";
import { flushEmailsSoon, ownerNotifyEmail } from "@/server/runtime";
import { loadBusiness } from "@/server/website";

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

// Five messages in ten minutes from one address, counted in the database (src/server/rate-limit.ts).
const CONTACT_LIMIT = { max: 5, windowMs: 10 * 60_000 };

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
  const address = clientAddress(await headers());
  const db = await getDb();

  const result = await sendContactMessage(
    db,
    { ...values, trap: formData.get("leave_blank") },
    { ownerEmail: ownerNotifyEmail(), allowSend: async () => (await limitRate(db, { key: `contact:${address}`, ...CONTACT_LIMIT }, new Date())).allowed },
  );

  if (result.ok) {
    flushEmailsSoon();
    return { status: "sent", error: "", fields: {}, values: EMPTY, attempt };
  }
  if (result.code === "invalid") {
    return { status: "error", error: "Please check the marked fields.", fields: result.fields, values, attempt };
  }
  const { phone } = await loadBusiness(await getDb());
  const error =
    result.code === "too_many"
      ? `You have sent several messages in a short time. Please wait a few minutes, or call us at ${phone}.`
      : `Sorry, messages cannot be sent from this page right now. Please call us at ${phone}.`;
  return { status: "error", error, fields: {}, values, attempt };
}
