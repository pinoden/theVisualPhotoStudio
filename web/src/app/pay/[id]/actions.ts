"use server";

import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { formText } from "@/lib/parse";
import { pretendToPay } from "@/server/pay-links";
import { flushEmailsSoon } from "@/server/runtime";

/**
 * Test mode only: "pay" a link made by the pretend processor. Nothing is
 * charged, as at checkout in test mode. `pretendToPay` refuses a link made by
 * a real processor, so this can never stand in for a real payment.
 */
export async function pretendPayAction(formData: FormData): Promise<void> {
  const id = formText(formData.get("id"));
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  await pretendToPay(await getDb(), id, new Date());
  flushEmailsSoon();
  redirect(`/pay/${id}`);
}
