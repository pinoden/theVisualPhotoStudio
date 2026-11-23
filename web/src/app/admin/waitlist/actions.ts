"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { can } from "@/lib/abilities";
import { formText } from "@/lib/parse";
import { requireManager } from "@/server/session";
import { loadSettings } from "@/server/settings";
import { removeFromWaitlist } from "@/server/waitlist";

/** Take a client off the waitlist: they are not emailed. The owners', and a manager's who may see customers. */
export async function removeFromWaitlistAction(formData: FormData): Promise<void> {
  const viewer = await requireManager("/admin/waitlist");
  const db = await getDb();
  if (!can(viewer, "seeCustomers", await loadSettings(db))) redirect("/admin/waitlist?error=" + encodeURIComponent("You cannot change the waitlist."));
  const removed = await removeFromWaitlist(db, formText(formData.get("id")), viewer.email, new Date());
  redirect(`/admin/waitlist?notice=${encodeURIComponent(removed ? "Taken off the waitlist: they will not be emailed." : "That place was already taken off.")}`);
}
