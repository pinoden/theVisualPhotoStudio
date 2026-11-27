"use server";

import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { formText } from "@/lib/parse";
import { fakePayLink, pretendToPay } from "@/server/pay-links";
import { flushEmailsSoon, payLinkDeps } from "@/server/runtime";

/**
 * Test mode only: "pay" a link made by the pretend processor. Nothing is
 * charged, as at checkout in test mode. `pretendToPay` refuses a link made by
 * a real processor, and any link once a real processor is set up, so this can
 * never stand in for a real payment.
 */
export async function pretendPayAction(formData: FormData): Promise<void> {
  const id = formText(formData.get("id"));
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  await pretendToPay(await getDb(), id, new Date(), (await payLinkDeps()).payments);
  flushEmailsSoon();
  redirect(`/pay/${id}`);
}

/** FAKE PAYMENT (temporary): the test button of a payment link's page. Refused unless the processor is a test one. */
export async function fakePayAction(formData: FormData): Promise<void> {
  const id = formText(formData.get("id"));
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  await fakePayLink(await getDb(), id, await payLinkDeps());
  flushEmailsSoon();
  redirect(`/pay/${id}`);
}
