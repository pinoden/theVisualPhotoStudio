"use server";

import { refresh } from "next/cache";
import { getDb } from "@/db/client";
import { saveEmailTemplate } from "@/server/email-templates";
import { requireOwner } from "@/server/session";

export interface TemplateFormState {
  status: "idle" | "saved" | "error";
  message: string;
  /** The revision the next save sends back. */
  revision: number;
  /** True while the owners' wording is saved, so that the site's can be brought back. */
  own: boolean;
  /** What was saved, for the editor to show: the site's wording after going back to it. */
  wording?: { subject: string; body: string };
}

/** Save an email's wording ("save"), or send it in the site's wording again ("restore"). */
export async function saveEmailTemplateAction(previous: TemplateFormState, formData: FormData): Promise<TemplateFormState> {
  const key = String(formData.get("key") ?? "");
  const viewer = await requireOwner(`/admin/emails/${encodeURIComponent(key)}`);
  const restore = formData.get("intent") === "restore";
  const revision = Number(formData.get("revision"));
  const wording = restore ? null : { subject: String(formData.get("subject") ?? ""), body: String(formData.get("body") ?? "") };
  const result = await saveEmailTemplate(await getDb(), viewer, key, wording, Number.isInteger(revision) ? revision : -1, new Date());
  if (!result.ok) return { ...previous, status: "error", message: result.message, wording: undefined };
  refresh();
  return {
    status: "saved",
    message: restore
      ? "Done. This email is sent in the site's wording again."
      : result.wording === "site"
        ? "Saved. This is the site's own wording, so the email is sent in it."
        : "Saved. Emails sent from now on use this wording.",
    revision: result.revision,
    own: result.wording === "owners",
    wording: { subject: result.subject, body: result.body },
  };
}
