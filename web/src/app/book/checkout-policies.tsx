import type { CheckoutPolicies } from "@/components/BookingFlow";
import { pageTextHtml } from "@/lib/site/page-text";
import { getCheckoutPolicies } from "@/server/cached";

/**
 * The studio policies of the booking pages' policies step (the owner's brief of 2026-11-22, item 6): the website's
 * Policies page as published, its headings and text without its banner (`pageTextHtml`), and the version a client accepts by reading it.
 */
export async function checkoutPolicies(): Promise<CheckoutPolicies | null> {
  const found = await getCheckoutPolicies();
  if (!found) return null;
  return {
    versionId: found.version.versionId,
    title: found.version.title,
    html: pageTextHtml(found.page.content.blocks, found.page.site),
  };
}
