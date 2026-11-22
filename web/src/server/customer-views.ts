import { and, count, desc, eq, gt } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { customerViews } from "@/db/schema";
import { normalizeEmail, type AuthUser } from "./auth";

/**
 * The access log of the customers' pages (question 27, answered 2026-11-18: "the site logs who opens a customer's
 * page"). A line is written when a customer's page is shown and when one of their receipts is downloaded, with who,
 * what and when. Only the owners read it, on the customer's page. Older lines go with the retention period
 * (`deleteOldRecords`).
 */

/** What was opened: the customer's page, one receipt (its booking's ref), or a year of receipts (the year). */
export type CustomerViewKind = "page" | "receipt" | "year";

/**
 * The same person opening the same thing again within these minutes adds no line: a page reloaded, saved or come
 * back to in that time is one visit.
 */
export const VIEW_GAP_MINUTES = 10;

/** Write that `viewer` opened `what` of the customer at `rawEmail`. Answers whether a line was written. */
export async function recordCustomerView(
  db: DbLike,
  viewer: AuthUser,
  rawEmail: string,
  what: CustomerViewKind,
  detail: string,
  now: Date,
): Promise<boolean> {
  const customerEmail = normalizeEmail(rawEmail);
  if (!customerEmail) return false;
  const since = new Date(now.getTime() - VIEW_GAP_MINUTES * 60_000);
  const [recent] = await db
    .select({ id: customerViews.id })
    .from(customerViews)
    .where(
      and(
        eq(customerViews.customerEmail, customerEmail),
        eq(customerViews.viewerEmail, viewer.email),
        eq(customerViews.what, what),
        eq(customerViews.detail, detail),
        gt(customerViews.viewedAt, since),
      ),
    )
    .limit(1);
  if (recent) return false;
  await db.insert(customerViews).values({
    customerEmail,
    viewerEmail: viewer.email,
    viewerName: viewer.name.slice(0, 200),
    viewerRole: viewer.role,
    what,
    detail: detail.slice(0, 40),
    viewedAt: now,
  });
  return true;
}

export interface CustomerView {
  viewerEmail: string;
  viewerName: string;
  viewerRole: string;
  what: CustomerViewKind;
  detail: string;
  viewedAt: string;
}

/** The newest lines of a customer's access log, and how many there are in all. */
export async function listCustomerViews(db: DbLike, rawEmail: string, limit = 30): Promise<{ views: CustomerView[]; total: number }> {
  const customerEmail = normalizeEmail(rawEmail);
  if (!customerEmail) return { views: [], total: 0 };
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        viewerEmail: customerViews.viewerEmail,
        viewerName: customerViews.viewerName,
        viewerRole: customerViews.viewerRole,
        what: customerViews.what,
        detail: customerViews.detail,
        viewedAt: customerViews.viewedAt,
      })
      .from(customerViews)
      .where(eq(customerViews.customerEmail, customerEmail))
      .orderBy(desc(customerViews.viewedAt))
      .limit(limit),
    db.select({ total: count() }).from(customerViews).where(eq(customerViews.customerEmail, customerEmail)),
  ]);
  return {
    views: rows.map((row) => ({ ...row, what: row.what as CustomerViewKind, viewedAt: row.viewedAt.toISOString() })),
    total,
  };
}
