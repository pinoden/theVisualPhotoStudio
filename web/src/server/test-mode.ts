import { and, asc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import { bookings, emailOutbox, loyaltyLedger, paymentLinks, payments, promoCodes, refunds } from "@/db/schema";
import type { Db, DbLike } from "@/db/client";
import { labelOf, type LabelFacts } from "@/lib/domain/labels";
import type { PromoKind } from "@/lib/domain/pricing";
import { formatCents } from "@/lib/domain/pricing";
import { MANUAL_PROVIDER } from "@/lib/payment-methods";
import { count } from "@/lib/words";
import { BY_SYSTEM, recordEvent } from "./history";
import { STANDS } from "./money";
import { giveBackUnmade } from "./promos";
import { formatInstant } from "./tz";

/**
 * Test mode and the live account, kept apart. The pretend processor and
 * Square's sandbox move no money. Each booking says which kind of money it is
 * (`bookings.money_kind`): `test` when it was made in test mode, `live` when
 * it was made with Square's live account (`moneyKindNow`, which also says what
 * a booking is when no processor is set up). Everything a booking makes is
 * that kind of money too: its payments, recorded by hand or not, its refunds,
 * links and codes.
 *
 * The two never pay for each other. A code a booking of one kind issued is
 * refused for a booking of the other (`moneyKindOfCode`), and so is a payment
 * link: real money is not charged for a pretend booking, and a pretend payment
 * does not mark a real booking paid.
 *
 * And a database must not hold both while it is used. With the live account,
 * test mode's bookings would count as money: credit from a reschedule code, a
 * pet fee's credit, a free hour, a refund, a receipt, cash recorded for a
 * pretend booking, all of it made from nothing. And test mode beside real
 * bookings would mix pretend ones with them. So the site refuses to open such
 * a database (`assertOneKindOfMoney`, from `getDb`), and says what to do:
 * `npm run db:clear-test-mode` removes what test mode made (`clearTestMode`),
 * and nothing else, so it is the way out whenever test money is where it must
 * not be, also when a server still running in test mode wrote it beside the
 * live account.
 */
export const TEST_PROCESSORS = ["mock", "square-sandbox"] as const;

/** The processor that takes real money: Square's live account. */
export const LIVE_PROCESSOR = "square";

export type MoneyKind = "test" | "live";

/** The kind of money a card processor moves, by its name: none for the pretend one and Square's sandbox. */
export function moneyKindOf(processor: string): MoneyKind {
  return (TEST_PROCESSORS as readonly string[]).includes(processor) ? "test" : "live";
}

/**
 * The kind of money a booking made now is. With a card processor set up, the
 * kind it moves. With none (the Square settings are missing or disagree, or
 * the studio takes no cards yet), the kind the database holds already, so
 * that a setting wrong for a while changes nothing for good: real where real
 * bookings are, test mode's where only test mode's are. In a database with no
 * booking yet: real on the live site, test mode's anywhere else, where the
 * pretend processor is what a site has when nothing is set.
 */
export async function moneyKindNow(db: DbLike, processor: string | null): Promise<MoneyKind> {
  if (processor !== null) return moneyKindOf(processor);
  const [real] = await db.select({ id: bookings.id }).from(bookings).where(eq(bookings.moneyKind, "live")).limit(1);
  if (real) return "live";
  const [pretend] = await db.select({ id: bookings.id }).from(bookings).where(eq(bookings.moneyKind, "test")).limit(1);
  if (pretend) return "test";
  return process.env.NODE_ENV === "production" ? "live" : "test";
}

/**
 * The kind of money behind a code: its booking's, for a code a booking issued
 * (a reschedule code, a pet fee's credit, a free hour a visit completed).
 * Null for a code no booking issued, which the owners made, or stamps added
 * by hand completed: it can be used wherever the owners' codes can.
 */
export async function moneyKindOfCode(db: DbLike, promoId: string): Promise<MoneyKind | null> {
  const [row] = await db
    .select({ kind: bookings.moneyKind })
    .from(promoCodes)
    .innerJoin(bookings, eq(bookings.id, promoCodes.originBookingId))
    .where(eq(promoCodes.id, promoId))
    .limit(1);
  return row?.kind ?? null;
}

/** Why a code is refused for a booking of the other kind of money than the one behind it, by the booking's kind. */
export const OTHER_MONEY_CODE: Record<MoneyKind, string> = {
  live: "That code was issued in test mode, when no money moved, so it cannot pay for a real booking.",
  test: "That code is real credit, and this site is in test mode: it cannot be used here.",
};

/** Why no payment link is made by a card processor of the other kind of money than the booking's, by the booking's kind. */
export const OTHER_MONEY_LINK: Record<MoneyKind, string> = {
  test: "This booking was made in test mode, when no money moved: it is not a real booking, and a payment link would charge a real card for it. Make the booking again here, then send the link for that one.",
  live: "This is a real booking, and this site is in test mode: a payment link made here would take a pretend payment for it. Send the link from the live site.",
};

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
  "Square's live account is set up, and this database holds what test mode recorded, when no money moved: bookings made then, or payments and payment links of its card processor. With the live account they would count as money (payments, cash recorded by hand, credit and codes). Remove them with `npm run db:clear-test-mode`, which lists them first and removes them when run again with `-- --yes`: it removes only what test mode made, and keeps every other booking, the website, the studios, prices, settings and staff. No server in test mode may use this database: what it books is test mode's again.";

export const TEST_ON_LIVE =
  "Test mode is set up (the pretend processor, or Square's sandbox), and this database holds real bookings, or payments of Square's live account. Test bookings would mix with them. Set up the live account's credentials here, or test with a new, empty database.";

/**
 * Refuses a database that holds the other kind of money than the processor
 * set up now: thrown when the database is opened, so that the site does not
 * run on it until it is put right. With no processor set up, no card money
 * can come in, and what is booked is of the kind the database holds
 * (`moneyKindNow`): nothing can mix.
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
 * For the admin's overview: what a server of the other mode wrote into the
 * database after this one opened it. The site refuses to start again on it
 * until that is put right. Null when there is nothing.
 */
export async function otherMoneyNotice(db: DbLike, processor: string | null): Promise<string | null> {
  if (processor === null) return null;
  const number = sql<number>`count(*)::int`;
  if (moneyKindOf(processor) === "test") {
    const [real] = await db.select({ n: number }).from(bookings).where(eq(bookings.moneyKind, "live"));
    if (real.n === 0) return null;
    return `${count(real.n, "real booking")} ${real.n === 1 ? "is" : "are"} in this database (made with Square's live account, or while no card processor was set up on the live site) beside test mode's. Test mode must not use a database with real bookings: the site refuses to start again on it.`;
  }
  // Test mode's bookings, and what its card processor recorded for real ones.
  const tests: string[] = [...TEST_PROCESSORS];
  const [[made], paid, linked] = await Promise.all([
    db.select({ n: number }).from(bookings).where(eq(bookings.moneyKind, "test")),
    db
      .select({ id: payments.bookingId })
      .from(payments)
      .innerJoin(bookings, eq(bookings.id, payments.bookingId))
      .where(and(inArray(payments.provider, tests), eq(bookings.moneyKind, "live"))),
    db
      .select({ id: paymentLinks.bookingId })
      .from(paymentLinks)
      .innerJoin(bookings, eq(bookings.id, paymentLinks.bookingId))
      .where(and(inArray(paymentLinks.provider, tests), eq(bookings.moneyKind, "live"))),
  ]);
  const touched = new Set([...paid, ...linked].map((row) => row.id)).size;
  if (made.n === 0 && touched === 0) return null;
  const left = [
    ...(made.n > 0 ? [`${count(made.n, "booking")} made in test mode`] : []),
    ...(touched > 0 ? [`pretend payments or payment links for ${count(touched, "real booking")}`] : []),
  ].join(", and ");
  return `A server in test mode is using this database beside this one. It left ${left}: none of it is real money. Stop that server, then remove it with npm run db:clear-test-mode: until then the site refuses to start again.`;
}

/** Mail that is not about a booking or a code, and always stays: messages from the contact form, and sign-in codes. */
const KEPT_MAIL = ["contact_message", "login_code"];

/**
 * A code that stays and is worth a look: one the owners made, or a free hour
 * that stamps added by hand completed (no booking issued it); one a test
 * booking issued that a real booking used; a free hour sent for visits some
 * of which were test mode's.
 */
export interface KeptCode {
  code: string;
  kind: PromoKind;
  /** What it is worth once test mode is cleared: with what test bookings took of it given back. */
  value: number;
  email: string | null;
  expiresAt: Date | null;
  cancelled: boolean;
  /** Bookings of test mode used it: their uses, and what they spent of it, are given back. */
  givenBack: boolean;
  /** A booking of test mode issued it, and a real booking used it: what is left of it is test money. */
  issuedInTestMode: boolean;
  /** A free hour of a client whose visits of test mode go: it may not have been earned by real visits. */
  earnedWithTestVisits: boolean;
}

/** A real booking for which a server in test mode recorded a pretend card payment, or made a pretend payment link. */
export interface PretendMoney {
  ref: string;
  customer: string;
  /** The pretend card payments recorded for it, and what the ones that counted came to. */
  payments: number;
  cents: number;
  links: number;
}

/** A booking made in test mode for which Square's live account took money, or made a payment link: it is real now. */
export interface MadeReal {
  ref: string;
  customer: string;
  startAt: Date;
  /** What the live account took for it. */
  cents: number;
}

/** A booking's reference where an email names it: "VS-" and six letters or digits. A code has more parts ("VS-AB12-CD34"). */
const BOOKING_REF_IN_TEXT = /\bVS-[0-9A-Z]{6}\b/g;

/** What `clearTestMode` removes, and what stays that a person should look at. */
export interface TestModeContents {
  /** Bookings made in test mode that go, whatever became of them. */
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
  /** Pretend payments and links that test mode's processors made for real bookings: they go, and the bookings stay. */
  pretend: PretendMoney[];
  /** Bookings made in test mode that the live account took money for: they stay, counted as real from now on. */
  madeReal: MadeReal[];
  /** Codes that stay and are worth a look (`KeptCode`). */
  keptCodes: KeptCode[];
  /** What the owners added to or took off clients' stamps by hand: it stays. */
  stampCorrections: { email: string; stamps: number; reason: string }[];
}

/** Whether the database holds nothing of test mode: no booking of it, and nothing its processors made for another. */
export function nothingOfTestMode(contents: TestModeContents): boolean {
  return contents.bookings === 0 && contents.pretend.length === 0 && contents.madeReal.length === 0;
}

interface ClearPlan {
  contents: TestModeContents;
  bookingIds: string[];
  /** The test bookings' payments, and the pretend ones of real bookings. */
  paymentIds: string[];
  linkIds: string[];
  codeIds: string[];
  mailIds: string[];
  /** Codes only test bookings used and no booking issued: given every use back. */
  resetCodeIds: string[];
  /** Test bookings that still hold what they took of a code that stays: each gives it back. */
  giveBack: { promoCodeId: string | null; promoDiscountCents: number; creditAppliedCents: number }[];
  /** The real bookings that lose pretend payments or links: their history says so. */
  pretend: (PretendMoney & { bookingId: string; status: string; label: LabelFacts["label"] })[];
  /** The bookings made in test mode that are real from now on: their history says so. */
  madeReal: { bookingId: string; status: string; label: LabelFacts["label"] }[];
}

/**
 * Whether a booking that ended gave back what it took of its code then, as the site does: one never made gave it back
 * when its hold ran out; one the client cancelled gave back a discount code's use and studio credit, but not a
 * reschedule credit; one the studio cancelled gave it back before the visit started (`giveCodeBack` in manage.ts). A
 * booking that stands, is still being paid for, or was released for a reschedule code still holds it.
 */
function gaveCodeBack(
  booking: { status: string; cancelReason: string | null; cancelledAt: Date | null; startAt: Date; creditAppliedCents: number },
  source: string | null,
): boolean {
  if (booking.status === "expired") return true;
  if (booking.status !== "cancelled" || booking.cancelReason === "rescheduled") return false;
  if (booking.cancelReason === "owner") return booking.cancelledAt !== null && booking.cancelledAt.getTime() < booking.startAt.getTime();
  return booking.creditAppliedCents === 0 || source !== "reschedule";
}

async function planClear(db: DbLike, now: Date): Promise<ClearPlan> {
  const tests: string[] = [...TEST_PROCESSORS];
  const [marked, [all]] = await Promise.all([
    db.select().from(bookings).where(eq(bookings.moneyKind, "test")).orderBy(asc(bookings.startAt)),
    db.select({ n: sql<number>`count(*)::int` }).from(bookings),
  ]);

  // A booking made in test mode for which the live account took money, or made a payment link that can be paid, is
  // not removed: the site would lose the record of real money. It stays, and counts as real from now on.
  const markedIds = marked.map((booking) => booking.id);
  const [realPaid, realLinked] =
    markedIds.length > 0
      ? await Promise.all([
          db
            .select({ bookingId: payments.bookingId, status: payments.status, amountCents: payments.amountCents })
            .from(payments)
            .where(and(eq(payments.provider, LIVE_PROCESSOR), inArray(payments.bookingId, markedIds))),
          db
            .select({ bookingId: paymentLinks.bookingId })
            .from(paymentLinks)
            .where(and(eq(paymentLinks.provider, LIVE_PROCESSOR), inArray(paymentLinks.bookingId, markedIds))),
        ])
      : [[], []];
  const madeRealIds = new Set([...realPaid, ...realLinked].map((row) => row.bookingId));
  const madeReal = marked.filter((booking) => madeRealIds.has(booking.id));
  const removed = marked.filter((booking) => !madeRealIds.has(booking.id));

  const bookingIds = removed.map((booking) => booking.id);
  const some = bookingIds.length > 0;
  const ofTestMode = new Set(bookingIds);
  // The test bookings' payments and links, and those that test mode's processors made for other bookings.
  const [paid, links, issued] = await Promise.all([
    db
      .select({ id: payments.id, bookingId: payments.bookingId, provider: payments.provider, status: payments.status, amountCents: payments.amountCents })
      .from(payments)
      .where(some ? or(inArray(payments.bookingId, bookingIds), inArray(payments.provider, tests)) : inArray(payments.provider, tests)),
    db
      .select({ id: paymentLinks.id, bookingId: paymentLinks.bookingId })
      .from(paymentLinks)
      .where(some ? or(inArray(paymentLinks.bookingId, bookingIds), inArray(paymentLinks.provider, tests)) : inArray(paymentLinks.provider, tests)),
    some ? db.select({ id: promoCodes.id, code: promoCodes.code }).from(promoCodes).where(inArray(promoCodes.originBookingId, bookingIds)) : [],
  ]);

  // A real booking a server in test mode took a pretend payment for, or sent a pretend link for, stays: only what
  // was pretend goes, and the booking owes again what that seemed to pay.
  const pretendPaid = paid.filter((payment) => !ofTestMode.has(payment.bookingId));
  const pretendLinks = links.filter((link) => !ofTestMode.has(link.bookingId));
  const pretendIds = [...new Set([...pretendPaid, ...pretendLinks].map((row) => row.bookingId))];
  const pretendBookings =
    pretendIds.length > 0
      ? await db
          .select({ id: bookings.id, ref: bookings.ref, customer: bookings.customerName, status: bookings.status, label: bookings.label })
          .from(bookings)
          .where(inArray(bookings.id, pretendIds))
          .orderBy(asc(bookings.startAt))
      : [];
  const pretend = pretendBookings.map((booking) => {
    const its = pretendPaid.filter((payment) => payment.bookingId === booking.id);
    return {
      bookingId: booking.id,
      status: booking.status,
      label: booking.label,
      ref: booking.ref,
      customer: booking.customer,
      payments: its.length,
      cents: its.filter((payment) => payment.status === "succeeded").reduce((sum, payment) => sum + payment.amountCents, 0),
      links: pretendLinks.filter((link) => link.bookingId === booking.id).length,
    };
  });

  // A code a test booking issued stays when a real booking used it: removing it would take from that booking the code
  // that paid for it. The owners are shown it, to cancel what is left of it.
  const usedByReal =
    issued.length > 0
      ? await db
          .select({ id: bookings.promoCodeId })
          .from(bookings)
          .where(and(inArray(bookings.promoCodeId, issued.map((code) => code.id)), notInArray(bookings.id, bookingIds)))
      : [];
  const keptIssued = new Set(usedByReal.map((row) => row.id).filter((id): id is string => id !== null));
  const removedCodes = issued.filter((code) => !keptIssued.has(code.id));
  const removedCodeIds = new Set(removedCodes.map((code) => code.id));

  // Codes the test bookings used that stay. One no booking issued and only test bookings used gets every use back. One
  // real bookings used too, or that a real booking issued, gets back what each test booking still holds of it.
  const usedIds = [...new Set(removed.map((booking) => booking.promoCodeId).filter((id): id is string => id !== null && !removedCodeIds.has(id)))];
  const [usedCodes, alsoReal] =
    usedIds.length > 0
      ? await Promise.all([
          db
            .select({ id: promoCodes.id, originBookingId: promoCodes.originBookingId, source: promoCodes.source })
            .from(promoCodes)
            .where(inArray(promoCodes.id, usedIds)),
          db
            .select({ id: bookings.promoCodeId })
            .from(bookings)
            .where(and(inArray(bookings.promoCodeId, usedIds), notInArray(bookings.id, bookingIds))),
        ])
      : [[], []];
  const shared = new Set(alsoReal.map((row) => row.id));
  const sourceOf = new Map<string, string>(usedCodes.map((code) => [code.id, code.source]));
  const resetCodeIds = usedCodes.filter((code) => code.originBookingId === null && !shared.has(code.id)).map((code) => code.id);
  const giveBack = removed.filter(
    (booking) =>
      booking.promoCodeId !== null &&
      usedIds.includes(booking.promoCodeId) &&
      !resetCodeIds.includes(booking.promoCodeId) &&
      !gaveCodeBack(booking, sourceOf.get(booking.promoCodeId) ?? null),
  );
  /** What each such booking gives back of a code of credit, by code. */
  const creditBack = new Map<string, number>();
  for (const booking of giveBack) {
    if (booking.promoDiscountCents > 0) creditBack.set(booking.promoCodeId!, (creditBack.get(booking.promoCodeId!) ?? 0) + booking.creditAppliedCents);
  }

  // Mail that has not gone out and is about test bookings or their codes only: it would reach a client after the
  // clear. One that names a booking that stays is about it, and stays.
  const removedRefs = new Set(removed.map((booking) => booking.ref));
  const removedCodeNames = removedCodes.map((code) => code.code);
  const waiting = some
    ? await db
        .select({ id: emailOutbox.id, subject: emailOutbox.subject, body: emailOutbox.body })
        .from(emailOutbox)
        .where(and(isNull(emailOutbox.sentAt), notInArray(emailOutbox.kind, KEPT_MAIL)))
    : [];
  const mailIds = waiting
    .filter((mail) => {
      const text = `${mail.subject}\n${mail.body}`;
      const refs = text.match(BOOKING_REF_IN_TEXT) ?? [];
      if (refs.some((ref) => !removedRefs.has(ref))) return false;
      return refs.length > 0 || removedCodeNames.some((code) => text.includes(code));
    })
    .map((mail) => mail.id);

  // The codes that stay and are worth a look. A free hour of a client whose visits of test mode go may not have been
  // earned by real visits: it is named, whatever booking completed it.
  const visitors = [...new Set(removed.filter((booking) => booking.status === "completed").map((booking) => booking.customerEmail.trim().toLowerCase()))];
  const worthALook = [
    isNull(promoCodes.originBookingId),
    ...(keptIssued.size > 0 ? [inArray(promoCodes.id, [...keptIssued])] : []),
    ...(visitors.length > 0 ? [and(eq(promoCodes.source, "loyalty"), eq(promoCodes.kind, "free_hour"), inArray(promoCodes.email, visitors))] : []),
  ];
  const [keptCodes, stampCorrections] = await Promise.all([
    db
      .select()
      .from(promoCodes)
      .where(and(or(...worthALook), removedCodeIds.size > 0 ? notInArray(promoCodes.id, [...removedCodeIds]) : undefined))
      .orderBy(asc(promoCodes.code)),
    db
      .select({ email: loyaltyLedger.email, stamps: loyaltyLedger.stamps, reason: loyaltyLedger.reason })
      .from(loyaltyLedger)
      .where(eq(loyaltyLedger.kind, "stamps"))
      .orderBy(asc(loyaltyLedger.createdAt)),
  ]);

  const ofBookings = paid.filter((payment) => ofTestMode.has(payment.bookingId));
  const byHand = ofBookings.filter((payment) => payment.provider === MANUAL_PROVIDER && payment.status === "succeeded");
  return {
    contents: {
      bookings: removed.length,
      upcoming: removed
        .filter((booking) => STANDS.includes(booking.status) && booking.endAt.getTime() > now.getTime())
        .map((booking) => ({ ref: booking.ref, customer: booking.customerName, startAt: booking.startAt })),
      keptBookings: all.n - removed.length,
      cardPayments: ofBookings.filter((payment) => payment.provider !== MANUAL_PROVIDER).length,
      links: links.filter((link) => ofTestMode.has(link.bookingId)).length,
      byHand: { count: byHand.length, cents: byHand.reduce((sum, payment) => sum + payment.amountCents, 0) },
      codes: removedCodes.length,
      mail: mailIds.length,
      pretend: pretend.map((entry) => ({ ref: entry.ref, customer: entry.customer, payments: entry.payments, cents: entry.cents, links: entry.links })),
      madeReal: madeReal.map((booking) => ({
        ref: booking.ref,
        customer: booking.customerName,
        startAt: booking.startAt,
        cents: realPaid.filter((payment) => payment.bookingId === booking.id && payment.status === "succeeded").reduce((sum, payment) => sum + payment.amountCents, 0),
      })),
      keptCodes: keptCodes.map((code) => ({
        code: code.code,
        kind: code.kind,
        value:
          code.kind !== "amount"
            ? code.value
            : resetCodeIds.includes(code.id)
              ? (code.issuedCents ?? code.value)
              : code.value + (creditBack.get(code.id) ?? 0),
        email: code.email,
        expiresAt: code.expiresAt,
        cancelled: code.voidedAt !== null,
        givenBack: usedIds.includes(code.id),
        issuedInTestMode: keptIssued.has(code.id),
        earnedWithTestVisits: code.source === "loyalty" && code.kind === "free_hour" && code.email !== null && visitors.includes(code.email),
      })),
      stampCorrections,
    },
    bookingIds,
    paymentIds: paid.map((payment) => payment.id),
    linkIds: links.map((link) => link.id),
    codeIds: [...removedCodeIds],
    mailIds,
    resetCodeIds,
    giveBack,
    pretend,
    madeReal: madeReal.map((booking) => ({ bookingId: booking.id, status: booking.status, label: booking.label })),
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

/** "1 card payment ($68) and 1 payment link": what was pretend of a real booking. */
function pretendInWords(entry: Pick<PretendMoney, "payments" | "cents" | "links">): string {
  return [
    ...(entry.payments > 0 ? [`${count(entry.payments, "card payment")} (${formatCents(entry.cents)})`] : []),
    ...(entry.links > 0 ? [count(entry.links, "payment link")] : []),
  ].join(" and ");
}

/** At most this many lines of a list: a database that took real money for long can have many. */
const LISTED = 40;

function listed<T>(items: T[], line: (item: T) => string): string[] {
  const lines = items.slice(0, LISTED).map((item) => `    ${line(item)}`);
  return items.length > LISTED ? [...lines, `    and ${items.length - LISTED} more`] : lines;
}

/** The contents in words, for the person who clears the database: what goes, then what stays and is worth a look. */
export function describeTestMode(contents: TestModeContents): string[] {
  if (nothingOfTestMode(contents)) {
    return [
      "Nothing of test mode is in this database: there is nothing to remove.",
      ...(contents.keptBookings > 0 ? [`Kept: ${count(contents.keptBookings, "booking")} of real money.`] : []),
    ];
  }
  const lines: string[] = [];
  if (contents.bookings > 0) {
    const one = contents.bookings === 1;
    const their = one ? "its" : "their";
    lines.push(`Removed: ${count(contents.bookings, "booking")} made in test mode, and ${their} history, whatever became of ${one ? "it" : "them"}.`);
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
  }
  if (contents.pretend.length > 0) {
    lines.push(
      `Removed: what test mode's card processor recorded for ${count(contents.pretend.length, "real booking")}, no money having moved. ${contents.pretend.length === 1 ? "The booking stays: look at what it owes now." : "The bookings stay: look at what each owes now."}`,
    );
    lines.push(...listed(contents.pretend, (entry) => `${entry.ref}, ${entry.customer}: ${pretendInWords(entry)}`));
  }
  if (contents.madeReal.length > 0) {
    lines.push(
      `Kept, and counted as real from now on: ${count(contents.madeReal.length, "booking")} made in test mode for which Square's live account took money, or made a payment link. Cancel any that was only a try, in the admin: its money is then refunded as any booking's.`,
    );
    lines.push(
      ...listed(
        contents.madeReal,
        (booking) => `${booking.ref}, ${booking.customer}, ${formatInstant(booking.startAt)}${booking.cents > 0 ? `: ${formatCents(booking.cents)} taken by the live account` : ""}`,
      ),
    );
  }
  // A database with real bookings is in use: its codes and stamps are real, and only those test mode touched are named.
  const inUse = contents.keptBookings > 0;
  if (inUse) lines.push(`Kept: ${count(contents.keptBookings, "booking")} of real money, with everything ${contents.keptBookings === 1 ? "it" : "they"} made.`);
  const codes = inUse ? contents.keptCodes.filter((code) => code.givenBack || code.issuedInTestMode || code.earnedWithTestVisits) : contents.keptCodes;
  if (codes.length > 0) {
    lines.push(
      inUse
        ? `Kept: ${count(codes.length, "code")} that test mode's bookings used, issued or helped to earn. Look at each, under Codes:`
        : `Kept, as real: ${count(codes.length, "code")}. Cancel any that was only a try, under Codes:`,
    );
    lines.push(
      ...listed(
        codes,
        (code) =>
          `${code.code}: ${codeValue(code)}, ${code.email ? `for ${code.email}` : "for anyone"}${code.expiresAt ? `, until ${formatInstant(code.expiresAt)}` : ""}` +
          `${code.cancelled ? ", cancelled" : ""}` +
          `${code.issuedInTestMode ? ", issued by a booking of test mode and used by a real one: what is left of it is test money" : ""}` +
          `${code.earnedWithTestVisits ? ", sent to a client whose visits of test mode go: it may not have been earned" : ""}` +
          `${code.givenBack ? ", used in test mode: what that took is given back" : ""}`,
      ),
    );
  }
  if (!inUse && contents.stampCorrections.length > 0) {
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
 * A customer's free hours are numbered in the order they were earned, and the next one takes the number after how
 * many were sent (`sendEarnedFreeHours` in loyalty.ts), which the database allows once. With some of them removed,
 * the ones that stay are numbered anew: otherwise the next one earned would take a number that is taken, and never
 * be sent. Lowest first, so that no number is ever held twice on the way.
 */
async function renumberFreeHours(tx: DbLike): Promise<void> {
  const numbered = await tx
    .select({ id: promoCodes.id, email: promoCodes.email, seq: promoCodes.loyaltySeq })
    .from(promoCodes)
    .where(isNotNull(promoCodes.loyaltySeq))
    .orderBy(asc(promoCodes.email), asc(promoCodes.loyaltySeq));
  let email: string | null = null;
  let next = 0;
  for (const code of numbered) {
    if (code.email !== email) {
      email = code.email;
      next = 0;
    }
    next++;
    if (code.seq !== next) await tx.update(promoCodes).set({ loyaltySeq: next }).where(eq(promoCodes.id, code.id));
  }
}

/**
 * Removes test mode's bookings and what they made (payments, refunds, links,
 * history, holds, the codes they issued and the entries about those, mail
 * about them that has not gone out), and gives the codes that stay what test
 * bookings still held of them. A pretend payment or link that test mode's
 * processor made for a real booking goes too; the booking stays, and its
 * history says so. A booking made in test mode for which the live account
 * took money stays, and counts as real from then on. Nothing else changes:
 * bookings of real money and all they made, the website, the studios, prices,
 * settings, staff and accounts, the owners' codes and changes of stamps.
 * Answers what it removed and kept.
 */
export async function clearTestMode(db: Db, now: Date): Promise<TestModeContents> {
  return db.transaction(async (tx) => {
    const plan = await planClear(tx, now);
    if (nothingOfTestMode(plan.contents)) return plan.contents;
    if (plan.resetCodeIds.length > 0) {
      await tx
        .update(promoCodes)
        .set({ usedCount: 0, value: sql`case when ${promoCodes.kind} = 'amount' then coalesce(${promoCodes.issuedCents}, ${promoCodes.value}) else ${promoCodes.value} end` })
        .where(inArray(promoCodes.id, plan.resetCodeIds));
    }
    for (const booking of plan.giveBack) await giveBackUnmade(tx, booking);
    if (plan.codeIds.length > 0) await tx.delete(loyaltyLedger).where(inArray(loyaltyLedger.codeId, plan.codeIds));
    if (plan.paymentIds.length > 0) await tx.delete(refunds).where(inArray(refunds.paymentId, plan.paymentIds));
    if (plan.linkIds.length > 0) await tx.delete(paymentLinks).where(inArray(paymentLinks.id, plan.linkIds));
    if (plan.paymentIds.length > 0) await tx.delete(payments).where(inArray(payments.id, plan.paymentIds));
    if (plan.mailIds.length > 0) await tx.delete(emailOutbox).where(inArray(emailOutbox.id, plan.mailIds));
    if (plan.codeIds.length > 0) {
      await tx.delete(promoCodes).where(inArray(promoCodes.id, plan.codeIds));
      await renumberFreeHours(tx);
    }
    // Their history, holds and add-ons go with them.
    if (plan.bookingIds.length > 0) await tx.delete(bookings).where(inArray(bookings.id, plan.bookingIds));
    for (const entry of plan.pretend) {
      const label = labelOf(entry);
      await recordEvent(tx, {
        bookingId: entry.bookingId,
        from: label,
        to: label,
        actor: BY_SYSTEM,
        at: now,
        note: `Removed what test mode's card processor had recorded for this booking, no money having moved: ${pretendInWords(entry)}`,
      });
    }
    if (plan.madeReal.length > 0) {
      await tx
        .update(bookings)
        .set({ moneyKind: "live" })
        .where(
          inArray(
            bookings.id,
            plan.madeReal.map((entry) => entry.bookingId),
          ),
        );
      for (const entry of plan.madeReal) {
        const label = labelOf(entry);
        await recordEvent(tx, {
          bookingId: entry.bookingId,
          from: label,
          to: label,
          actor: BY_SYSTEM,
          at: now,
          note: "Made in test mode, and counted as a real booking from now on: Square's live account took money for it, or made a payment link for it",
        });
      }
    }
    return plan.contents;
  });
}
