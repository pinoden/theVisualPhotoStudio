import type { DbLike } from "@/db/client";
import { ownerRefundOwedNotice, queueEmail } from "./email";

/**
 * A refund the studio owes after its own move or change of a booking.
 *
 * Moved to a day that costs less, or changed to hold less, a paid booking has been paid for more than it costs
 * (`creditLeftCentsByBooking` in money.ts). The client's email says "we will refund it to you", and nothing gives it
 * back by itself: an owner refunds it on the appointment's page ("Refund the remaining credit"). Until 2026-11-27
 * nobody was told: a manager with prices switched off saw nothing of it, and an owner only by opening that
 * appointment (the preview test of 2026-11-21, point 10). Now the owners get an email when it comes about, the
 * Overview lists every such booking until it is refunded (`listRefundsOwed` in admin.ts), and whoever cannot see the
 * booking's payments reads on its page that a refund is owed.
 */

/** Where a notice to the owners goes, and the site's address for the link in it. Null `ownerEmail`: no address is set, and none is sent. */
export interface OwnerNotice {
  ownerEmail: string | null;
  baseUrl: string;
}

/**
 * Tell the owners, once the change is written, when it left the booking with more paid beyond its price than before.
 * `change` is a sentence of what was done and by whom. A change that leaves that amount as it was, or lessens it,
 * tells nobody again.
 */
export async function noticeRefundOwed(
  tx: DbLike,
  booking: { ref: string; customerName: string },
  credit: { beforeCents: number; afterCents: number },
  change: string,
  notice: OwnerNotice | undefined,
): Promise<void> {
  if (!notice?.ownerEmail || credit.afterCents <= 0 || credit.afterCents <= credit.beforeCents) return;
  await queueEmail(
    tx,
    ownerRefundOwedNotice({
      to: notice.ownerEmail,
      ref: booking.ref,
      customer: booking.customerName,
      cents: credit.afterCents,
      change,
      appointmentUrl: `${notice.baseUrl.replace(/\/$/, "")}/admin/appointments/${booking.ref}`,
    }),
  );
}
