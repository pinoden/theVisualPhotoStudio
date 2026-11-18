"use server";

import { headers } from "next/headers";
import { getDb } from "@/db/client";
import { joinMembership, type JoinResult } from "@/server/memberships";
import { resolvePayments } from "@/server/payments";
import { RateLimiter } from "@/server/rate-limit";
import { flushEmailsSoon, ownerNotifyEmail, siteUrl } from "@/server/runtime";

// As many attempts a minute from one address as a booking allows: ten, or what the browser tests' server sets.
const perMinute = process.env.NODE_ENV === "production" ? 10 : Number(process.env.BOOKING_REQUESTS_PER_MINUTE) || 10;
const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: perMinute });

/** Buy a membership from the checkout page (`joinMembership`): its first month, its card kept, its subscription. */
export async function joinMembershipAction(input: unknown): Promise<JoinResult> {
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  if (!limiter.check(ip).allowed) return { ok: false, status: 429, code: "rate_limited", message: "Too many requests. Please wait a moment." };
  const result = await joinMembership(await getDb(), input, {
    now: new Date(),
    payments: resolvePayments().provider,
    baseUrl: await siteUrl(),
    ownerEmail: ownerNotifyEmail(),
  });
  if (result.ok) flushEmailsSoon();
  return result;
}
