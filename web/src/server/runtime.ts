import { headers } from "next/headers";
import { after } from "next/server";
import { getDb } from "@/db/client";
import { deliverPendingEmails, resolveEmailTransport } from "./email";
import type { ManageDeps } from "./manage";
import { resolvePayments } from "./payments";
import { ownerEmails } from "./session";
import type { TaskDeps } from "./tasks";

/**
 * Glue between the request and the services in this folder: where the site
 * lives, which processor and mail service to use, and who to notify. The
 * services take these as arguments so tests can supply their own.
 */

/** The site's public origin, for links in emails. */
/**
 * The website's address as configured (`SITE_URL`), or null. For what is
 * worked out while a page is prerendered (the addresses in its metadata),
 * which cannot ask the request the way `siteUrl` does.
 */
export function configuredSiteUrl(): string | null {
  return process.env.SITE_URL ? process.env.SITE_URL.replace(/\/$/, "") : null;
}

export async function siteUrl(): Promise<string> {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/** Where refund notices go: OWNER_NOTIFY_EMAIL, else the first owner address. */
export function ownerNotifyEmail(): string | null {
  return process.env.OWNER_NOTIFY_EMAIL?.trim().toLowerCase() || ownerEmails()[0] || null;
}

export async function manageDeps(): Promise<ManageDeps> {
  return {
    now: new Date(),
    payments: resolvePayments().provider,
    ownerEmail: ownerNotifyEmail(),
    baseUrl: await siteUrl(),
  };
}

/** What the payment-link service needs: the processor, and where this site lives. */
export async function payLinkDeps(): Promise<Pick<ManageDeps, "now" | "payments" | "baseUrl">> {
  return { now: new Date(), payments: resolvePayments().provider, baseUrl: await siteUrl() };
}

export async function taskDeps(): Promise<TaskDeps> {
  return { ...(await manageDeps()), email: resolveEmailTransport() };
}

/** Deliver queued email once the response has been sent, without delaying it. */
export function flushEmailsSoon(): void {
  after(async () => {
    try {
      await deliverPendingEmails(await getDb(), resolveEmailTransport(), new Date());
    } catch (error) {
      console.error("Email delivery failed", error);
    }
  });
}
