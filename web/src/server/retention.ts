import { lt } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { customerViews, emailChanges, emailOutbox, loginCodes, sessions } from "@/db/schema";

/** What `deleteOldRecords` removed. */
export interface RecordsDeleted {
  emails: number;
  loginCodes: number;
  sessions: number;
  customerViews: number;
}

/** The moment `years` calendar years before `now`: what is older is deleted. */
export function retentionCutoff(now: Date, years: number): Date {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  return cutoff;
}

/**
 * Delete what the site keeps only as a record, once it is older than the owners' retention period
 * (`retentionYears`, the owner's answer of 2026-11-21: 5 years):
 * - the copies of the emails it wrote (`email_outbox`, contact-form messages among them), by when each was written;
 * - the sign-in codes it gave, by when each was given (each lasts minutes), and the codes and records of email
 *   address changes (`email_changes`) with them;
 * - the sign-ins (`sessions`), by when each ended;
 * - the access log of the customers' pages (`customer_views`), by when each was opened.
 * Bookings, payments, clients and their history are not touched. From the scheduled task; safe to run twice.
 */
export async function deleteOldRecords(db: DbLike, now: Date, years: number): Promise<RecordsDeleted> {
  const cutoff = retentionCutoff(now, years);
  const emails = await db.delete(emailOutbox).where(lt(emailOutbox.createdAt, cutoff)).returning({ id: emailOutbox.id });
  const codes = await db.delete(loginCodes).where(lt(loginCodes.createdAt, cutoff)).returning({ id: loginCodes.id });
  const changes = await db.delete(emailChanges).where(lt(emailChanges.createdAt, cutoff)).returning({ id: emailChanges.id });
  const ended = await db.delete(sessions).where(lt(sessions.expiresAt, cutoff)).returning({ id: sessions.id });
  const views = await db.delete(customerViews).where(lt(customerViews.viewedAt, cutoff)).returning({ id: customerViews.id });
  return { emails: emails.length, loginCodes: codes.length + changes.length, sessions: ended.length, customerViews: views.length };
}
