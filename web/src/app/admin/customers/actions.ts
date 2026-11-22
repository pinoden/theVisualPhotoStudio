"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { count } from "@/lib/words";
import { formText, intInRange } from "@/lib/parse";
import { normalizeEmail } from "@/server/auth";
import { adjustStamps, cancelReward, MAX_STAMPS_AT_ONCE, restoreReward } from "@/server/rewards";
import { flushEmailsSoon, siteUrl } from "@/server/runtime";
import { requireManager } from "@/server/session";

/**
 * What is corrected on a customer's page: stamps, and the status of a reward.
 * For the owners, and for a manager the owners have allowed. Every action
 * starts with `requireManager`; the service then checks that this viewer may
 * correct loyalty, and writes who made the change, when and why.
 */

/** The customer's page, to come back to. Anything that is not an email address goes back to the list. */
function customerPage(formData: FormData): string {
  const email = normalizeEmail(formText(formData.get("email")));
  return email ? `/admin/customers/${encodeURIComponent(email)}` : "/admin/customers";
}

const withMessage = (path: string, kind: "notice" | "error", text: string, anchor = "") =>
  `${path}?${kind}=${encodeURIComponent(text)}${anchor}`;

export async function adjustStampsAction(formData: FormData): Promise<void> {
  const page = customerPage(formData);
  const owner = await requireManager(page);
  const amount = intInRange(formText(formData.get("stamps")), 1, MAX_STAMPS_AT_ONCE);
  const direction = formText(formData.get("direction"));
  if (amount === null || (direction !== "add" && direction !== "take")) {
    redirect(withMessage(page, "error", `Enter how many stamps, from 1 to ${MAX_STAMPS_AT_ONCE}, and whether to add them or take them away.`));
  }
  const result = await adjustStamps(
    await getDb(),
    owner,
    { email: formText(formData.get("email")), stamps: direction === "add" ? amount : -amount, reason: formText(formData.get("reason")) },
    { now: new Date(), baseUrl: await siteUrl() },
  );
  if (!result.ok) redirect(withMessage(page, "error", result.message));
  flushEmailsSoon();
  const sent = result.sent > 0 ? ` That completed ${count(result.sent, "free hour")}, emailed to the customer just now.` : "";
  redirect(
    withMessage(
      page,
      "notice",
      `${count(amount, "stamp")} ${direction === "add" ? "added" : "taken away"}. The customer now has ${count(result.standing.stamps, "stamp")}.${sent}`,
    ),
  );
}

export async function cancelRewardAction(formData: FormData): Promise<void> {
  const page = customerPage(formData);
  const owner = await requireManager(page);
  const result = await cancelReward(await getDb(), owner, formText(formData.get("codeId")), formText(formData.get("reason")), new Date());
  if (!result.ok) redirect(withMessage(page, "error", result.message));
  redirect(withMessage(page, "notice", `Reward ${result.code} cancelled. It can no longer be used, and the customer sees it as Canceled.`));
}

export async function restoreRewardAction(formData: FormData): Promise<void> {
  const page = customerPage(formData);
  const owner = await requireManager(page);
  const result = await restoreReward(await getDb(), owner, formText(formData.get("codeId")), formText(formData.get("reason")), new Date());
  if (!result.ok) redirect(withMessage(page, "error", result.message));
  redirect(withMessage(page, "notice", `Reward ${result.code} given back. It can be used again, until the date it always had.`));
}

