import { eq, inArray, ne, sql } from "drizzle-orm";
import { bookings, emailOutbox, loyaltyLedger, paymentLinks, payments, promoCodes, refunds } from "@/db/schema";
import type { Db, DbLike } from "@/db/client";

/**
 * Test mode and the live account, kept apart. The pretend processor and
 * Square's sandbox move no money: what they record (`payments.provider`,
 * `payment_links.provider`) is test money. A database holds test money or live
 * money, never both. On a database that holds test mode's bookings, the live
 * account would count them as money: credit from a reschedule code, a pet
 * fee's credit, a free hour, a refund, a receipt, all of it made from nothing.
 * And test mode on a database that took real payments would mix pretend
 * bookings with them. So the site refuses to open either
 * (`assertOneKindOfMoney`, from `getDb`), and says what to do:
 * `npm run db:clear-test-mode` makes a test database ready for the live
 * account (`clearTestMode`), keeping everything the owners set up.
 */
export const TEST_PROCESSORS = ["mock", "square-sandbox"] as const;

/** The processor that takes real money: Square's live account. */
export const LIVE_PROCESSOR = "square";

/** Whether the database holds a payment or a payment link of any of these processors. */
async function holdsMoneyOf(db: DbLike, processors: readonly string[]): Promise<boolean> {
  const [payment] = await db.select({ id: payments.id }).from(payments).where(inArray(payments.provider, [...processors])).limit(1);
  if (payment) return true;
  const [link] = await db.select({ id: paymentLinks.id }).from(paymentLinks).where(inArray(paymentLinks.provider, [...processors])).limit(1);
  return link !== undefined;
}

export const LIVE_ON_TEST =
  "The live card processor (Square's live account) is set up, and this database holds bookings paid in test mode, when no money moved. With the live account they would count as money. Make the database ready for it with `npm run db:clear-test-mode`, which removes the bookings and what they made and keeps the website, the studios, prices, settings and staff; or start from a new database.";

export const TEST_ON_LIVE =
  "Test mode is set up (the pretend processor, or Square's sandbox), and this database took real payments through Square's live account. Test mode's bookings would mix with them. Set up the live account's credentials here, or test on a copy of the database.";

/**
 * Refuses a database that would mix test money and live money with the
 * processor set up now: thrown when the database is opened, so that the site
 * does not run on it until it is put right. No processor set up: nothing to mix.
 */
export async function assertOneKindOfMoney(db: DbLike, processor: string | null): Promise<void> {
  if (processor === null) return;
  if (processor === LIVE_PROCESSOR) {
    if (await holdsMoneyOf(db, TEST_PROCESSORS)) throw new Error(LIVE_ON_TEST);
  } else if (await holdsMoneyOf(db, [LIVE_PROCESSOR])) {
    throw new Error(TEST_ON_LIVE);
  }
}

/**
 * Makes a test database ready for the live account: removes every booking and
 * what bookings made (payments, refunds, links, history, holds, the codes they
 * issued, loyalty corrections, queued mail), and gives the owners' own codes
 * their uses and amounts back. Keeps everything else: the website and its
 * pictures and fonts, the studios, hours, prices, add-ons, settings, blocked
 * time, photography, staff and accounts. Refused, changing nothing, on a
 * database that took real payments.
 */
export async function clearTestMode(db: Db): Promise<{ bookings: number }> {
  if (await holdsMoneyOf(db, [LIVE_PROCESSOR])) {
    throw new Error("This database took real payments through Square's live account, so nothing was cleared: test mode is cleared only from a test database.");
  }
  return db.transaction(async (tx) => {
    await tx.delete(refunds);
    await tx.delete(paymentLinks);
    await tx.delete(payments);
    // Their history, holds and add-ons go with them.
    const removed = await tx.delete(bookings).returning({ id: bookings.id });
    await tx.delete(promoCodes).where(ne(promoCodes.source, "manual"));
    await tx
      .update(promoCodes)
      .set({ usedCount: 0, value: sql`case when ${promoCodes.kind} = 'amount' then coalesce(${promoCodes.issuedCents}, ${promoCodes.value}) else ${promoCodes.value} end` })
      .where(eq(promoCodes.source, "manual"));
    await tx.delete(loyaltyLedger);
    await tx.delete(emailOutbox);
    return { bookings: removed.length };
  });
}
