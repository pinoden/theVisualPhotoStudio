import { and, asc, eq, gt, inArray, ne, notInArray, sql } from "drizzle-orm";
import { bookings, emailOutbox, loyaltyLedger, moneyKind, paymentLinks, payments, promoCodes, refunds } from "@/db/schema";
import type { Db, DbLike } from "@/db/client";
import { formatCents } from "@/lib/domain/pricing";
import { MANUAL_PROVIDER } from "@/lib/payment-methods";
import { count } from "@/lib/words";
import { STANDS } from "./money";
import { formatInstant } from "./tz";

/**
 * Test mode and the live account, kept apart. The pretend processor and
 * Square's sandbox move no money: whatever is recorded while one of them is
 * set up is test money, the bookings made in the admin and the payments
 * recorded by hand included. A database holds test money or live money, never
 * both, and says which (`money_kind`): `test` once it was opened in test mode,
 * `live` once it was opened with Square's live account. On a database of test
 * mode, the live account would count what test mode left as money: credit
 * from a reschedule code, a pet fee's credit, a free hour, a refund, a
 * receipt, cash recorded for a pretend booking, all of it made from nothing.
 * And test mode on a database of the live account would mix pretend bookings
 * with real ones. So the site refuses to open either (`assertOneKindOfMoney`,
 * from `getDb`), and says what to do: `npm run db:clear-test-mode` makes a
 * database of test mode ready for the live account (`clearTestMode`), keeping
 * everything the owners set up.
 */
export const TEST_PROCESSORS = ["mock", "square-sandbox"] as const;

/** The processor that takes real money: Square's live account. */
export const LIVE_PROCESSOR = "square";

export type MoneyKind = "test" | "live";

/** Which kind of money the database holds, as it says: null for one never opened with a card processor. */
export async function storedMoneyKind(db: DbLike): Promise<MoneyKind | null> {
  const [row] = await db.select({ kind: moneyKind.kind }).from(moneyKind).limit(1);
  return row?.kind ?? null;
}

async function storeMoneyKind(db: DbLike, kind: MoneyKind, now: Date): Promise<void> {
  await db.insert(moneyKind).values({ id: 1, kind, setAt: now }).onConflictDoUpdate({ target: moneyKind.id, set: { kind, setAt: now } });
}

/** Whether the database holds a payment or a payment link of any of these processors. */
async function holdsMoneyOf(db: DbLike, processors: readonly string[]): Promise<boolean> {
  const [payment] = await db.select({ id: payments.id }).from(payments).where(inArray(payments.provider, [...processors])).limit(1);
  if (payment) return true;
  const [link] = await db.select({ id: paymentLinks.id }).from(paymentLinks).where(inArray(paymentLinks.provider, [...processors])).limit(1);
  return link !== undefined;
}

async function holdsBookings(db: DbLike): Promise<boolean> {
  const [booking] = await db.select({ id: bookings.id }).from(bookings).limit(1);
  return booking !== undefined;
}

export const LIVE_ON_TEST =
  "Square's live account is set up, and this database was used in test mode, when no money moved: what was recorded then (bookings, card payments, cash recorded by hand, credit and codes) would count as money with the live account. Make it ready for the live account with `npm run db:clear-test-mode`, which lists what it would remove and removes it when run again with `-- --yes`, keeping the website, the studios, prices, settings and staff; or start from a new database.";

export const TEST_ON_LIVE =
  "Test mode is set up (the pretend processor, or Square's sandbox), and this database has been used with Square's live account: test bookings would mix with real ones. Set up the live account's credentials here, or test with a new, empty database.";

/**
 * Refuses a database that would mix test money and live money with the
 * processor set up now: thrown when the database is opened, so that the site
 * does not run on it until it is put right. Otherwise the database is marked
 * with the kind it now holds. No processor set up: no card money can come in,
 * and nothing is decided.
 */
export async function assertOneKindOfMoney(db: DbLike, processor: string | null, now: Date = new Date()): Promise<void> {
  if (processor === null) return;
  const want: MoneyKind = processor === LIVE_PROCESSOR ? "live" : "test";
  const stored = await storedMoneyKind(db);
  if (want === "live") {
    // Test mode's card records always count. In a database that ran in test mode, every booking does: one made in the
    // admin and paid at the studio was pretend too. With none left (cleared), the database is ready.
    if ((await holdsMoneyOf(db, TEST_PROCESSORS)) || (stored === "test" && (await holdsBookings(db)))) throw new Error(LIVE_ON_TEST);
  } else if (stored === "live" || (await holdsMoneyOf(db, [LIVE_PROCESSOR]))) {
    throw new Error(TEST_ON_LIVE);
  }
  if (stored !== want) await storeMoneyKind(db, want, now);
}

export const NOT_CLEARED_LIVE =
  "This database has been used with Square's live account, so nothing was cleared: test mode is cleared only from a database of test mode.";

export const NOT_CLEARED_UNKNOWN =
  "This database has bookings and has never been opened in test mode, so they may be real (made while no card processor was set up): nothing was cleared.";

/** A database `clearTestMode` may clear: one of test mode, never one that took or recorded real money. */
async function assertTestDatabase(db: DbLike): Promise<void> {
  const stored = await storedMoneyKind(db);
  if (stored === "live" || (await holdsMoneyOf(db, [LIVE_PROCESSOR]))) throw new Error(NOT_CLEARED_LIVE);
  if (stored === null && (await holdsBookings(db)) && !(await holdsMoneyOf(db, TEST_PROCESSORS))) throw new Error(NOT_CLEARED_UNKNOWN);
}

/** Mail that is not about a booking or a code, and stays: messages visitors sent through the contact form, and sign-in codes. */
const KEPT_MAIL = ["contact_message", "login_code"];

/** What `clearTestMode` removes from a database of test mode, and what of the owners' it keeps. */
export interface TestModeContents {
  /** Every booking, whatever became of it. */
  bookings: number;
  /** Those that stand and are still to come: people may think they have them. */
  upcoming: { ref: string; customer: string; startAt: Date }[];
  /** Card payments of test mode, taken or only reserved. */
  cardPayments: number;
  links: number;
  /** Payments recorded by hand (cash, the studio's own card reader), and what they came to. */
  byHand: { count: number; cents: number };
  /** Codes that bookings and visits issued: reschedule codes, pet fees' credit, free hours. */
  codes: number;
  /** The owners' own codes: kept, with the uses and the amounts bookings took of them given back. */
  ownCodes: number;
  /** What the owners added to or took off clients' stamps by hand: kept, as their codes are. */
  stampCorrections: { email: string; stamps: number; reason: string }[];
  /** Mail about bookings and codes, sent or waiting. */
  mail: number;
  /** Messages from the contact form: kept, sent or waiting. */
  contactMessages: number;
}

/** What clearing the database would remove and keep. Refused, as `clearTestMode` is, on a database of live money. */
export async function testModeContents(db: DbLike, now: Date): Promise<TestModeContents> {
  await assertTestDatabase(db);
  const number = sql<number>`count(*)::int`;
  const [[all], upcoming, [card], [links], [byHand], [codes], [ownCodes], stampCorrections, [mail], [contact]] = await Promise.all([
    db.select({ n: number }).from(bookings),
    db
      .select({ ref: bookings.ref, customer: bookings.customerName, startAt: bookings.startAt })
      .from(bookings)
      .where(and(inArray(bookings.status, [...STANDS] as (typeof bookings.$inferSelect.status)[]), gt(bookings.endAt, now)))
      .orderBy(asc(bookings.startAt)),
    db.select({ n: number }).from(payments).where(ne(payments.provider, MANUAL_PROVIDER)),
    db.select({ n: number }).from(paymentLinks),
    db
      .select({ n: number, cents: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int` })
      .from(payments)
      .where(and(eq(payments.provider, MANUAL_PROVIDER), eq(payments.status, "succeeded"))),
    db.select({ n: number }).from(promoCodes).where(ne(promoCodes.source, "manual")),
    db.select({ n: number }).from(promoCodes).where(eq(promoCodes.source, "manual")),
    db
      .select({ email: loyaltyLedger.email, stamps: loyaltyLedger.stamps, reason: loyaltyLedger.reason })
      .from(loyaltyLedger)
      .where(eq(loyaltyLedger.kind, "stamps"))
      .orderBy(asc(loyaltyLedger.createdAt)),
    db.select({ n: number }).from(emailOutbox).where(notInArray(emailOutbox.kind, KEPT_MAIL)),
    db.select({ n: number }).from(emailOutbox).where(eq(emailOutbox.kind, "contact_message")),
  ]);
  return {
    bookings: all.n,
    upcoming,
    cardPayments: card.n,
    links: links.n,
    byHand: { count: byHand.n, cents: byHand.cents },
    codes: codes.n,
    ownCodes: ownCodes.n,
    stampCorrections,
    mail: mail.n,
    contactMessages: contact.n,
  };
}

/** The contents in words, for the person who clears the database: what goes, then what stays. */
export function describeTestMode(contents: TestModeContents): string[] {
  const lines = [`Removed: ${count(contents.bookings, "booking")}, whatever became of them, with their history.`];
  if (contents.upcoming.length > 0) {
    lines.push(`  ${count(contents.upcoming.length, "booking")} of them still to come, which the client may think they have:`);
    for (const booking of contents.upcoming) lines.push(`    ${booking.ref}, ${booking.customer}, ${formatInstant(booking.startAt)}`);
  }
  lines.push(`Removed: ${count(contents.cardPayments, "card payment")} of test mode and ${count(contents.links, "payment link")}, with their refunds.`);
  if (contents.byHand.count > 0) {
    lines.push(`Removed: ${count(contents.byHand.count, "payment")} recorded by hand, ${formatCents(contents.byHand.cents)} in all.`);
  }
  lines.push(`Removed: ${count(contents.codes, "code")} that bookings and visits issued (reschedule codes, pet fees' credit, free hours).`);
  lines.push(`Removed: ${count(contents.mail, "email")} about bookings and codes, sent or waiting.`);
  lines.push(`Kept: ${count(contents.ownCodes, "code")} the owners made, with their uses given back.`);
  if (contents.stampCorrections.length > 0) {
    lines.push(`Kept: ${count(contents.stampCorrections.length, "change")} of clients' stamps made by hand. Take back any that was only a try, on the customer's page:`);
    for (const change of contents.stampCorrections) lines.push(`    ${change.email}: ${change.stamps > 0 ? `+${change.stamps}` : change.stamps}, ${change.reason}`);
  }
  if (contents.contactMessages > 0) lines.push(`Kept: ${count(contents.contactMessages, "message")} from the contact form.`);
  lines.push("Kept: the website, its pictures and fonts, the studios, hours, prices, add-ons, settings, blocked time, photography, staff and accounts.");
  return lines;
}

/**
 * Makes a database of test mode ready for the live account: removes every
 * booking and what bookings made (payments, refunds, links, history, holds,
 * the codes they issued, mail about them), and gives the owners' own codes
 * their uses and amounts back. Keeps everything else: the website and its
 * pictures and fonts, the studios, hours, prices, add-ons, settings, blocked
 * time, photography, staff and accounts, the owners' changes of stamps, and
 * the contact form's messages. Refused, changing nothing, on a database that
 * took or recorded real money. Answers what it removed and kept.
 */
export async function clearTestMode(db: Db, now: Date): Promise<TestModeContents> {
  return db.transaction(async (tx) => {
    const contents = await testModeContents(tx, now);
    await tx.delete(refunds);
    await tx.delete(paymentLinks);
    await tx.delete(payments);
    // Their history, holds and add-ons go with them.
    await tx.delete(bookings);
    // The entries about rewards go with their codes; the owners' changes of stamps stay, as their own codes do.
    const issued = tx.select({ id: promoCodes.id }).from(promoCodes).where(ne(promoCodes.source, "manual"));
    await tx.delete(loyaltyLedger).where(inArray(loyaltyLedger.codeId, issued));
    await tx.delete(promoCodes).where(ne(promoCodes.source, "manual"));
    await tx
      .update(promoCodes)
      .set({ usedCount: 0, value: sql`case when ${promoCodes.kind} = 'amount' then coalesce(${promoCodes.issuedCents}, ${promoCodes.value}) else ${promoCodes.value} end` })
      .where(eq(promoCodes.source, "manual"));
    await tx.delete(emailOutbox).where(notInArray(emailOutbox.kind, KEPT_MAIL));
    return contents;
  });
}
