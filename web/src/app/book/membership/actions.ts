"use server";

import { headers } from "next/headers";
import { getDb } from "@/db/client";
import { mayUseTestTools } from "@/server/browser-test-server";
import { joinMembership, type JoinResult } from "@/server/memberships";
import { resolvePayments } from "@/server/payments";
import { clientAddress, limitRate } from "@/server/rate-limit";
import { flushEmailsSoon, ownerNotifyEmail, siteUrl } from "@/server/runtime";

// As many attempts a minute from one address as a booking allows: ten, or what the browser tests' server sets.
const perMinute = mayUseTestTools() ? Number(process.env.BOOKING_REQUESTS_PER_MINUTE) || 10 : 10;

/** Buy a membership from the checkout page (`joinMembership`): its first month, its card kept, its subscription. */
export async function joinMembershipAction(input: unknown): Promise<JoinResult> {
  const limit = { key: `membership:${clientAddress(await headers())}`, max: perMinute, windowMs: 60_000 };
  if (!(await limitRate(await getDb(), limit, new Date())).allowed) return { ok: false, status: 429, code: "rate_limited", message: "Too many requests. Please wait a moment." };
  const result = await joinMembership(await getDb(), input, {
    now: new Date(),
    payments: resolvePayments().provider,
    baseUrl: await siteUrl(),
    ownerEmail: ownerNotifyEmail(),
  });
  if (result.ok) flushEmailsSoon();
  return result;
}
