import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { bookings, emailOutbox, loyaltyLedger, paymentLinks, payments, promoCodes, refunds } from "@/db/schema";
import type { Db, DbLike } from "@/db/client";
import type { PromoKind } from "@/lib/domain/pricing";
import { formatCents } from "@/lib/domain/pricing";
import { MANUAL_PROVIDER } from "@/lib/payment-methods";
import { count } from "@/lib/words";
import { STANDS } from "./money";
import { giveBackUnmade } from "./promos";
import { formatInstant } from "./tz";

/**
 * Test mode and the live account, kept apart. The pretend processor and
 * Square's sandbox move no money. Each booking says which kind of money it is
 * (`bookings.money_kind`), from the processor set up when it was made: `test`
 * in test mode, `live` with Square's live account or with no processor at all.
 * Everything a booking makes is that kind of money too: its payments, recorded
 * by hand or not, its refunds, links and codes.
 *
 * A database must not hold both while it is used. With the live account,
 * test mode's bookings would count as money: credit from a reschedule code, a
 * pet fee's credit, a free hour, a refund, a receipt, cash recorded for a
 * pretend booking, all of it made from nothing. And test mode beside real
 * bookings would mix pretend ones with them. So the site refuses to open such
 * a database (`assertOneKindOfMoney`, from `getDb`), and says what to do:
 * `npm run db:clear-test-mode` removes test mode's bookings and what they made
 * (`clearTestMode`), and nothing else, so it is the way out whenever test
 * money is where it must not be, also when a server still running in test
 * mode wrote it beside the live account.
 */
export const TEST_PROCESSORS = ["mock", "square-sandbox"] as const;

/** The processor that takes real money: Square's live account. */
export const LIVE_PROCESSOR = "square";

export type MoneyKind = "test" | "live";

/** The kind of money a booking made now is, by the processor set up (its name): test in test mode, else live. */
export function moneyKindOf(processor: string | null): MoneyKind {
  return processor !== null && (TEST_PROCESSORS as readonly string[]).includes(processor) ? "test" : "live";
}

/** Whether the database holds bookings of this kind of money, or card payments or links of its processors. */
async function holdsMoney(db: DbLike, kind: MoneyKind): Promise<boolean> {
  const [booking] = await db.select({ id: bookings.id }).from(bookings).where(eq(bookings.moneyKind, kind)).limit(1);
  if (booking) return true;
  const processors: string[] = kind === "test" ? [...TEST_PROCESSORS] : [LIVE_PROCESSOR];
  const [payment] = await db.select({ id: payments.id }).from(payments).where(inArray(payments.provider, processors)).limit(1);
  if (payment) return true;
  const [link] = await db.select({ id: paymentLinks.id }).from(paymentLinks).where(inArray(paymentLinks.provider, processors)).limit(1);
  return link !== undefined;
}

export const LIVE_ON_TEST =
  "Square's live account is set up, and this database holds bookings made in test mode, when no money moved: with the live account, what they recorded (payments, cash recorded by hand, credit and codes) would count as money. Remove them with `npm run db:clear-test-mode`, which lists them first and removes them when run again with `-- --yes`: it removes only what test mode made, and keeps every other booking, the website, the studios, prices, settings and staff. No server in test mode may use this database: what it books is test mode's again.";

export const TEST_ON_LIVE =
  "Test mode is set up (the pretend processor, or Square's sandbox), and this database holds real bookings: made with Square's live account, or while no card processor was set up. Test bookings would mix with them. Set up the live account's credentials here, or test with a new, empty database.";

/**
 * Refuses a database that holds the other kind of money than the processor
 * set up now: thrown when the database is opened, so that the site does not
 * run on it until it is put right. No processor set up: no card money can
 * come in, and what is booked counts as real.
 */
export async function assertOneKindOfMoney(db: DbLike, processor: string | null): Promise<void> {
  if (processor === null) return;
  if (moneyKindOf(processor) === "live") {
    if (await holdsMoney(db, "test")) throw new Error(LIVE_ON_TEST);
  } else if (await holdsMoney(db, "live")) {
    throw new Error(TEST_ON_LIVE);
  }
}

/**
 * For the admin's overview: bookings of the other kind of money than the processor set up now, which a server of
 * the other mode wrote after this one opened the database. The site refuses to start again on it until they are
 * put right. Null when there are none.
 */
export async function otherMoneyNotice(db: DbLike, processor: string | null): Promise<string | null> {
  if (processor === null) return null;
  const live = moneyKindOf(processor) === "live";
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(bookings).where(eq(bookings.moneyKind, live ? "test" : "live"));
  if (row.n === 0) return null;
  const are = row.n === 1 ? "is" : "are";
  return live
    ? `${count(row.n, "booking")} made in test mode ${are} in this database: a server in test mode is using it beside this one. They are not real money. Stop that server, then remove them with npm run db:clear-test-mode: until then the site refuses to start again.`
    : `${count(row.n, "real booking")} ${are} in this database (made with Square's live account, or with no card processor set up) beside test mode's. Test mode must not use a database with real bookings: the site refuses to start again on it.`;
}

/** Mail that is not about a booking or a code, and always stays: messages from the contact form, and sign-in codes. */
const KEPT_MAIL = ["contact_message", "login_code"];

/** A code the owners made, or a free hour that stamps added by hand completed: no booking issued it. */
export interface KeptCode {
  code: string;
  kind: PromoKind;
  value: number;
  email: string | null;
  expiresAt: Date | null;
  cancelled: boolean;
  /** Bookings of test mode used it: their uses, and what they spent of it, are given back. */
  givenBack: boolean;
}

/** What `clearTestMode` removes, and what stays that a person should look at. */
export interface TestModeContents {
  /** Bookings made in test mode, whatever became of them. */
  bookings: number;
  /** Those that stand and are still to come: people may think they have them. */
  upcoming: { ref: string; customer: string; startAt: Date }[];
  /** Bookings of real money: they stay, with everything they made. */
  keptBookings: number;
  /** The test bookings' card payments, taken or only reserved, and their payment links. */
  cardPayments: number;
  links: number;
  /** The test bookings' payments recorded by hand, and what they came to. */
  byHand: { count: number; cents: number };
  /** Codes the test bookings issued: reschedule codes, pet fees' credit, free hours their visits earned. */
  codes: number;
  /** Mail about the test bookings and their codes that has not gone out. */
  mail: number;
  /** Codes no booking issued: they stay, as real. */
  keptCodes: KeptCode[];
  /** What the owners added to or took off clients' stamps by hand: it stays. */
  stampCorrections: { email: string; stamps: number; reason: string }[];
}

interface ClearPlan {
  contents: TestModeContents;
  bookingIds: string[];
  paymentIds: string[];
  codeIds: string[];
  mailIds: string[];
  /** Codes only test bookings used and no booking issued: given every use back. */
  resetCodeIds: string[];
  /** Test bookings that stand and used a code that stays, shared with real bookings: each gives back what it holds. */
  giveBack: { promoCodeId: string | null; promoDiscountCents: number; creditAppliedCents: number }[];
}

async function planClear(db: DbLike, now: Date): Promise<ClearPlan> {
  const tests: string[] = [...TEST_PROCESSORS];
  const [marked, paidThere, linkedThere, [all]] = await Promise.all([
    db.select({ id: bookings.id }).from(bookings).where(eq(bookings.moneyKind, "test")),
    db.select({ id: payments.bookingId }).from(payments).where(inArray(payments.provider, tests)),
    db.select({ id: paymentLinks.bookingId }).from(paymentLinks).where(inArray(paymentLinks.provider, tests)),
    db.select({ n: sql<number>`count(*)::int` }).from(bookings),
  ]);
  const bookingIds = [...new Set([...marked, ...paidThere, ...linkedThere].map((row) => row.id))];
  const some = bookingIds.length > 0;
  const [removed, paid, links, issued] = some
    ? await Promise.all([
        db.select().from(bookings).where(inArray(bookings.id, bookingIds)).orderBy(asc(bookings.startAt)),
        db
          .select({ id: payments.id, provider: payments.provider, status: payments.status, amountCents: payments.amountCents })
          .from(payments)
          .where(inArray(payments.bookingId, bookingIds)),
        db.select({ id: paymentLinks.id }).from(paymentLinks).where(inArray(paymentLinks.bookingId, bookingIds)),
        db.select({ id: promoCodes.id, code: promoCodes.code }).from(promoCodes).where(inArray(promoCodes.originBookingId, bookingIds)),
      ])
    : [[], [], [], []];
  const issuedIds = new Set(issued.map((code) => code.id));

  // Codes the test bookings used that stay. One no booking issued and only test bookings used gets every use back; one
  // real bookings used too gets back what each standing test booking holds (one that ended gave back what it had to).
  const usedIds = [...new Set(removed.map((booking) => booking.promoCodeId).filter((id): id is string => id !== null && !issuedIds.has(id)))];
  const [usedCodes, alsoReal] =
    usedIds.length > 0
      ? await Promise.all([
          db.select({ id: promoCodes.id, originBookingId: promoCodes.originBookingId }).from(promoCodes).where(inArray(promoCodes.id, usedIds)),
          db
            .select({ id: bookings.promoCodeId })
            .from(bookings)
            .where(and(inArray(bookings.promoCodeId, usedIds), notInArray(bookings.id, bookingIds))),
        ])
      : [[], []];
  const shared = new Set(alsoReal.map((row) => row.id));
  const resetCodeIds = usedCodes.filter((code) => code.originBookingId === null && !shared.has(code.id)).map((code) => code.id);
  const giveBack = removed.filter(
    (booking) => booking.promoCodeId !== null && usedIds.includes(booking.promoCodeId) && !resetCodeIds.includes(booking.promoCodeId) && STANDS.includes(booking.status),
  );

  // Mail that has not gone out and names a test booking or one of its codes: it would reach a client after the clear.
  const names = [...removed.map((booking) => booking.ref), ...issued.map((code) => code.code)];
  const waiting =
    names.length > 0
      ? await db
          .select({ id: emailOutbox.id, subject: emailOutbox.subject, body: emailOutbox.body })
          .from(emailOutbox)
          .where(and(isNull(emailOutbox.sentAt), notInArray(emailOutbox.kind, KEPT_MAIL)))
      : [];
  const mailIds = waiting.filter((mail) => names.some((name) => mail.subject.includes(name) || mail.body.includes(name))).map((mail) => mail.id);

  const [ownCodes, stampCorrections] = await Promise.all([
    db.select().from(promoCodes).where(isNull(promoCodes.originBookingId)).orderBy(asc(promoCodes.code)),
    db
      .select({ email: loyaltyLedger.email, stamps: loyaltyLedger.stamps, reason: loyaltyLedger.reason })
      .from(loyaltyLedger)
      .where(eq(loyaltyLedger.kind, "stamps"))
      .orderBy(asc(loyaltyLedger.createdAt)),
  ]);

  const byHand = paid.filter((payment) => payment.provider === MANUAL_PROVIDER && payment.status === "succeeded");
  return {
    contents: {
      bookings: removed.length,
      upcoming: removed
        .filter((booking) => STANDS.includes(booking.status) && booking.endAt.getTime() > now.getTime())
        .map((booking) => ({ ref: booking.ref, customer: booking.customerName, startAt: booking.startAt })),
      keptBookings: all.n - removed.length,
      cardPayments: paid.filter((payment) => payment.provider !== MANUAL_PROVIDER).length,
      links: links.length,
      byHand: { count: byHand.length, cents: byHand.reduce((sum, payment) => sum + payment.amountCents, 0) },
      codes: issued.length,
      mail: mailIds.length,
      keptCodes: ownCodes.map((code) => ({
        code: code.code,
        kind: code.kind,
        value: code.value,
        email: code.email,
        expiresAt: code.expiresAt,
        cancelled: code.voidedAt !== null,
        givenBack: usedIds.includes(code.id),
      })),
      stampCorrections,
    },
    bookingIds,
    paymentIds: paid.map((payment) => payment.id),
    codeIds: [...issuedIds],
    mailIds,
    resetCodeIds,
    giveBack,
  };
}

/** What clearing test mode would remove from the database, and what stays that a person should look at. */
export async function testModeContents(db: DbLike, now: Date): Promise<TestModeContents> {
  return (await planClear(db, now)).contents;
}

/** "10% off", "$50 of credit", "a free hour". */
function codeValue(code: KeptCode): string {
  return code.kind === "percent" ? `${code.value}% off` : code.kind === "amount" ? `${formatCents(code.value)} of credit` : "a free hour";
}

/** At most this many lines of a list: a database that took real money for long can have many. */
const LISTED = 40;

function listed<T>(items: T[], line: (item: T) => string): string[] {
  const lines = items.slice(0, LISTED).map((item) => `    ${line(item)}`);
  return items.length > LISTED ? [...lines, `    and ${items.length - LISTED} more`] : lines;
}

/** The contents in words, for the person who clears the database: what goes, then what stays and is worth a look. */
export function describeTestMode(contents: TestModeContents): string[] {
  if (contents.bookings === 0) {
    return [
      "Nothing of test mode is in this database: there is nothing to remove.",
      ...(contents.keptBookings > 0 ? [`Kept: ${count(contents.keptBookings, "booking")} of real money.`] : []),
    ];
  }
  const one = contents.bookings === 1;
  const their = one ? "its" : "their";
  const lines = [`Removed: ${count(contents.bookings, "booking")} made in test mode, and ${their} history, whatever became of ${one ? "it" : "them"}.`];
  if (contents.upcoming.length > 0) {
    lines.push(
      one
        ? "  It is still to come, and the client may think they have it:"
        : `  ${count(contents.upcoming.length, "booking")} of them still to come, which the client may think they have:`,
    );
    lines.push(...listed(contents.upcoming, (booking) => `${booking.ref}, ${booking.customer}, ${formatInstant(booking.startAt)}`));
  }
  lines.push(`Removed: ${their} ${count(contents.cardPayments, "card payment")} and ${count(contents.links, "payment link")}, with their refunds.`);
  if (contents.byHand.count > 0) {
    lines.push(`Removed: ${their} ${count(contents.byHand.count, "payment")} recorded by hand, ${formatCents(contents.byHand.cents)} in all.`);
  }
  lines.push(`Removed: ${count(contents.codes, "code")} ${one ? "it" : "they"} issued (reschedule codes, pet fees' credit, free hours visits earned).`);
  lines.push(`Removed: ${count(contents.mail, "email")} about ${one ? "it" : "them"} that had not gone out.`);
  if (contents.keptBookings > 0) lines.push(`Kept: ${count(contents.keptBookings, "booking")} of real money, with everything they made.`);
  if (contents.keptCodes.length > 0) {
    lines.push(`Kept, as real: ${count(contents.keptCodes.length, "code")} no booking issued. Cancel any that was only a try, under Codes:`);
    lines.push(
      ...listed(
        contents.keptCodes,
        (code) =>
          `${code.code}: ${codeValue(code)}, ${code.email ? `for ${code.email}` : "for anyone"}${code.expiresAt ? `, until ${formatInstant(code.expiresAt)}` : ""}` +
          `${code.cancelled ? ", cancelled" : ""}${code.givenBack ? ", used in test mode: what that took is given back" : ""}`,
      ),
    );
  }
  if (contents.stampCorrections.length > 0) {
    lines.push(
      `Kept: ${count(contents.stampCorrections.length, "change")} of clients' stamps made by hand. Take back any that was only a try, on the customer's page (Admin, Customers lists only people with bookings: open the address given):`,
    );
    lines.push(
      ...listed(
        contents.stampCorrections,
        (change) => `${change.email}: ${change.stamps > 0 ? `+${change.stamps}` : change.stamps}, ${change.reason}, /admin/customers/${encodeURIComponent(change.email)}`,
      ),
    );
  }
  lines.push("Kept: the website, its pictures and fonts, the studios, hours, prices, add-ons, settings, blocked time, photography, staff and accounts, sent mail and the contact form's messages.");
  return lines;
}

/**
 * Removes test mode's bookings and what they made (payments, refunds, links,
 * history, holds, the codes they issued and the entries about those, mail
 * about them that has not gone out), and gives the codes that stay what test
 * bookings took of them. Nothing else changes: bookings of real money and all
 * they made, the website, the studios, prices, settings, staff and accounts,
 * the owners' codes and changes of stamps. Answers what it removed and kept.
 */
export async function clearTestMode(db: Db, now: Date): Promise<TestModeContents> {
  return db.transaction(async (tx) => {
    const plan = await planClear(tx, now);
    if (plan.bookingIds.length === 0) return plan.contents;
    if (plan.resetCodeIds.length > 0) {
      await tx
        .update(promoCodes)
        .set({ usedCount: 0, value: sql`case when ${promoCodes.kind} = 'amount' then coalesce(${promoCodes.issuedCents}, ${promoCodes.value}) else ${promoCodes.value} end` })
        .where(inArray(promoCodes.id, plan.resetCodeIds));
    }
    for (const booking of plan.giveBack) await giveBackUnmade(tx, booking);
    if (plan.codeIds.length > 0) await tx.delete(loyaltyLedger).where(inArray(loyaltyLedger.codeId, plan.codeIds));
    if (plan.paymentIds.length > 0) await tx.delete(refunds).where(inArray(refunds.paymentId, plan.paymentIds));
    await tx.delete(paymentLinks).where(inArray(paymentLinks.bookingId, plan.bookingIds));
    await tx.delete(payments).where(inArray(payments.bookingId, plan.bookingIds));
    if (plan.mailIds.length > 0) await tx.delete(emailOutbox).where(inArray(emailOutbox.id, plan.mailIds));
    if (plan.codeIds.length > 0) await tx.delete(promoCodes).where(inArray(promoCodes.id, plan.codeIds));
    // Their history, holds and add-ons go with them.
    await tx.delete(bookings).where(inArray(bookings.id, plan.bookingIds));
    return plan.contents;
  });
}
