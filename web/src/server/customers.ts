import { desc, eq, sql } from "drizzle-orm";
import { promoCodes, users } from "@/db/schema";
import { queryRows, type DbLike } from "@/db/client";
import { can } from "@/lib/abilities";
import type { LoyaltyStanding } from "@/lib/domain/loyalty";
import type { PromoKind } from "@/lib/domain/pricing";
import { loadAppointments, type AccountBooking } from "./account";
import { normalizeEmail, type AuthUser } from "./auth";
import { listStampChanges, loyaltyStandingOf, type StampChange } from "./loyalty";
import type { PromoSource } from "./promos";
import { loadReceipts, type Receipt, type Unpaid } from "./receipts";
import { listRewardChanges, listRewards, type Reward, type RewardChange } from "./rewards";
import { loadSettings } from "./settings";

/**
 * Customers as the owners see them: who has booked, and for one customer
 * everything the studio knows, in one place: their appointments, what they
 * paid, their stamps and their rewards.
 *
 * A customer is an email address. Bookings, codes and stamps are all kept by
 * it, and signing in proves it. Owners may look, and managers when the
 * owners have switched it on (`managerSeesCustomers`); every function here
 * checks the viewer and answers null to anyone else. An attendant never can.
 * A manager sees money (prices, payments, receipts, credit) only with
 * `managerSeesPrices`: without it those parts come back empty.
 */

export interface CustomerSummary {
  email: string;
  /** The name and phone on their latest booking. */
  name: string;
  phone: string;
  /** Bookings that stand or took place: confirmed, completed or missed. */
  bookings: number;
  /** The start of their latest completed visit. */
  lastVisit: string | null;
  /** The start of their next confirmed booking. */
  nextVisit: string | null;
  /** Whether they have ever signed in. */
  hasAccount: boolean;
}

/** A term a person typed, made safe to put inside a LIKE pattern. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * Everyone who has a booking, newest booking first. `q` narrows the list to
 * the names and email addresses that contain it. Abandoned checkouts do not
 * make someone a customer.
 */
export async function listCustomers(
  db: DbLike,
  viewer: AuthUser,
  options: { q?: string; now: Date; limit?: number },
): Promise<CustomerSummary[] | null> {
  if (!can(viewer, "seeCustomers", await loadSettings(db))) return null;
  const term = (options.q ?? "").trim().slice(0, 100);
  const pattern = likePattern(term);
  const rows = await queryRows<{
    email: string;
    name: string;
    phone: string;
    bookings: number;
    last_visit: string | Date | null;
    next_visit: string | Date | null;
    has_account: boolean;
  }>(
    db,
    sql`
      select b.customer_email as email,
             (array_agg(b.customer_name order by b.created_at desc))[1] as name,
             (array_agg(b.customer_phone order by b.created_at desc))[1] as phone,
             count(*) filter (where b.status in ('confirmed', 'completed', 'no_show'))::int as bookings,
             max(b.start_at) filter (where b.status = 'completed') as last_visit,
             min(b.start_at) filter (where b.status = 'confirmed' and b.end_at > ${options.now.toISOString()}::timestamptz) as next_visit,
             exists (select 1 from users u where u.email = b.customer_email) as has_account
      from bookings b
      where b.status not in ('pending_payment', 'expired')
        and (${term} = '' or b.customer_email ilike ${pattern} or b.customer_name ilike ${pattern})
      group by b.customer_email
      order by max(b.created_at) desc
      limit ${Math.min(Math.max(options.limit ?? 200, 1), 500)}
    `,
  );
  return rows.map((row) => ({
    email: row.email,
    name: row.name,
    phone: row.phone,
    bookings: row.bookings,
    lastVisit: row.last_visit ? new Date(row.last_visit).toISOString() : null,
    nextVisit: row.next_visit ? new Date(row.next_visit).toISOString() : null,
    hasAccount: row.has_account,
  }));
}

/** A code a customer holds or held, of any kind, with what became of it. */
export interface CustomerCodeRow {
  id: string;
  code: string;
  kind: PromoKind;
  value: number;
  source: PromoSource;
  issuedAt: string;
  expiresAt: string | null;
  /** In the studio's words: Available, Used, Expired or Cancelled. */
  state: "available" | "used" | "expired" | "cancelled";
  note: string;
}

export interface CustomerPage {
  email: string;
  name: string;
  phone: string;
  hasAccount: boolean;
  upcoming: AccountBooking[];
  past: AccountBooking[];
  /** Null while loyalty is switched off. */
  standing: LoyaltyStanding | null;
  /** Stamps needed for a free hour, as the owners set it. */
  perReward: number;
  /** When loyalty last started over: stamps are counted from then. Null when every visit counts. */
  stampsCountedFrom: string | null;
  /** Every change made by hand, the ones from before loyalty started over included: they are the record. */
  stampChanges: StampChange[];
  rewards: Reward[];
  rewardChanges: RewardChange[];
  /** Credit and discount codes: every code of theirs that is not a reward. */
  codes: CustomerCodeRow[];
  receipts: Receipt[];
  unpaid: Unpaid[];
  /** What this viewer may see and do on the page. */
  may: {
    /** Prices, payments, receipts and credit. When false, those parts are empty and every amount is 0. */
    seeMoney: boolean;
    /** Add or take away stamps, and cancel a reward or give it back. */
    correctLoyalty: boolean;
  };
}

/**
 * Everything about one customer, for an owner. The address does not have to
 * have a booking: an owner can open the page of someone who has only stamps
 * added by hand, or nothing yet. Null for anyone who is not an owner, and for
 * something that is not an email address.
 */
export async function getCustomer(db: DbLike, viewer: AuthUser, rawEmail: string, now: Date): Promise<CustomerPage | null> {
  const settings = await loadSettings(db);
  if (!can(viewer, "seeCustomers", settings)) return null;
  const email = normalizeEmail(rawEmail);
  if (!email) return null;
  const seeMoney = can(viewer, "seePrices", settings);
  /** A booking without its amounts, for a manager who may not see what things cost. */
  const withoutMoney = (booking: AccountBooking): AccountBooking => ({
    ...booking,
    studios: booking.studios.map((studio) => ({ ...studio, priceCents: 0 })),
    addons: booking.addons.map((addon) => ({ ...addon, unitCents: 0 })),
    studiosSubtotalCents: 0,
    multiStudioDiscountCents: 0,
    addonsCents: 0,
    promoDiscountCents: 0,
    creditAppliedCents: 0,
    totalCents: 0,
    receivedCents: 0,
    dueCents: 0,
  });

  const [appointments, account, rewards, rewardChanges, stampChanges, money, codeRows] = await Promise.all([
    loadAppointments(db, email, now),
    db.select({ name: users.name, phone: users.phone }).from(users).where(eq(users.email, email)).limit(1),
    listRewards(db, email, now),
    listRewardChanges(db, email),
    listStampChanges(db, email),
    loadReceipts(db, email),
    db.select().from(promoCodes).where(eq(promoCodes.email, email)).orderBy(desc(promoCodes.createdAt)),
  ]);
  // The name and phone they last booked with: the page of a customer shows the person, not a row.
  const latest = [...appointments.upcoming, ...appointments.past].sort((a, b) => (a.startAt < b.startAt ? 1 : -1))[0];

  return {
    email,
    name: latest?.customerName || account[0]?.name || "",
    phone: (await latestPhone(db, email)) || account[0]?.phone || "",
    hasAccount: account.length > 0,
    upcoming: seeMoney ? appointments.upcoming : appointments.upcoming.map(withoutMoney),
    past: seeMoney ? appointments.past : appointments.past.map(withoutMoney),
    standing: settings.loyaltyEnabled ? await loyaltyStandingOf(db, email, settings) : null,
    perReward: settings.loyaltyVisits,
    stampsCountedFrom: settings.loyaltyStartedAt,
    stampChanges,
    rewards,
    rewardChanges,
    codes: (seeMoney ? codeRows : [])
      .filter((code) => code.kind !== "free_hour")
      .map((code) => ({
        id: code.id,
        code: code.code,
        kind: code.kind,
        value: code.value,
        source: code.source,
        issuedAt: code.createdAt.toISOString(),
        expiresAt: code.expiresAt ? code.expiresAt.toISOString() : null,
        state: code.voidedAt
          ? "cancelled"
          : (code.kind === "amount" ? code.value <= 0 : code.usedCount >= code.maxUses)
            ? "used"
            : code.expiresAt && code.expiresAt.getTime() <= now.getTime()
              ? "expired"
              : "available",
        note: code.note,
      })),
    receipts: seeMoney ? money.receipts : [],
    unpaid: seeMoney ? money.unpaid : [],
    may: { seeMoney, correctLoyalty: can(viewer, "correctLoyalty", settings) },
  };
}

/** The phone number on a customer's latest booking. Kept out of what customers' own pages load. */
async function latestPhone(db: DbLike, email: string): Promise<string> {
  const rows = await queryRows<{ phone: string }>(
    db,
    sql`select customer_phone as phone from bookings where customer_email = ${email} and customer_phone <> '' order by created_at desc limit 1`,
  );
  return rows[0]?.phone ?? "";
}
