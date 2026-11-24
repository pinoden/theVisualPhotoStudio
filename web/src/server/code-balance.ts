import { and, asc, eq } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { bookings, membershipMinutes, membershipPlanStudios, memberships, promoCodes, studios } from "@/db/schema";
import { formatCents } from "@/lib/domain/pricing";
import { minutesLeftOf } from "./membership-minutes";
import { normalizeCode } from "./promos";
import { formatDay } from "./tz";
import { promoDaysInWords, readPromoDays } from "@/lib/domain/promo-days";

/**
 * "Check Code Balance" on the booking page (the owner's brief of 2026-11-22, item 5): what a code is worth before a
 * booking, by the code alone. It reads and changes nothing: a code is spent only when a booking is made. It says what
 * the code is, whether it can be used, what is left on it, when it ends and what it is for, and never whose it is: no
 * name, and no email address, only that the code works with the address it was sent to. What the builder read into
 * the brief is question 60 in ProjectLibrary.md.
 */

/** `cancelled` (by the studio) and `unpaid` (a membership never paid for) are for the studio's own check only: a client's finds no such code. */
export type CodeStatus = "usable" | "used" | "expired" | "cancelled" | "unpaid";

export interface CodeBalance {
  code: string;
  /** "Studio credit", "Reschedule code", "Discount code", "Free studio hour", "Membership". */
  title: string;
  status: CodeStatus;
  /** "$75 remaining", "180 minutes remaining", "20% off, usable once", "One free hour". */
  remaining: string;
  /** The day it ends in studio time ("Dec 31, 2026", as the account's rewards say it), or null when it does not. */
  expires: string | null;
  /** What it can pay for, and who can use it. */
  restrictions: string[];
}

export type CodeBalanceResult = { found: true; balance: CodeBalance } | { found: false };

const uses = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

function minutesText(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "One free hour" : `${hours} free hours`;
  }
  return `${minutes} free minutes`;
}

const orList = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`);

/** Look a code up. A code the studio cancelled, and a membership never paid for, are "not found", as at checkout. */
export async function checkCodeBalance(db: DbLike, rawCode: unknown, now: Date): Promise<CodeBalanceResult> {
  const code = normalizeCode(rawCode);
  if (code.length < 4 || code.length > 40) return { found: false };
  const [member] = await db.select().from(memberships).where(eq(memberships.code, code)).limit(1);
  if (member) {
    if (member.status === "starting" || member.status === "failed") return { found: false };
    return { found: true, balance: await membershipBalance(db, member) };
  }
  const [row] = await db.select().from(promoCodes).where(eq(promoCodes.code, code)).limit(1);
  if (!row || row.voidedAt) return { found: false };
  return { found: true, balance: promoBalance(row, now) };
}

async function membershipBalance(db: DbLike, member: typeof memberships.$inferSelect): Promise<CodeBalance> {
  const minutesLeft = await minutesLeftOf(db, member.id);
  const covered = await db
    .select({ name: studios.name })
    .from(membershipPlanStudios)
    .innerJoin(studios, eq(studios.id, membershipPlanStudios.studioId))
    .where(eq(membershipPlanStudios.planId, member.planId))
    .orderBy(asc(studios.sortOrder));
  const unpaid = member.status === "starting" || member.status === "failed";
  return {
    code: member.code,
    title: `Membership: ${member.planName}`,
    status: unpaid ? "unpaid" : minutesLeft > 0 ? "usable" : "used",
    remaining: `${minutesLeft} minutes remaining`,
    // Unused hours carry over: a membership's minutes do not end.
    expires: null,
    restrictions: [
      `For studio rentals in ${orList(covered.map((studio) => studio.name))}, not for photography or content creation sessions.`,
      "Works only with the email address of the membership.",
    ],
  };
}

function promoBalance(row: typeof promoCodes.$inferSelect, now: Date): CodeBalance {
  const expired = row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime();
  const usesLeft = Math.max(0, row.maxUses - row.usedCount);
  const usedUp = row.kind === "amount" ? row.value <= 0 : usesLeft === 0;

  const restrictions: string[] = [];
  if (row.photographyOnly) restrictions.push("For photography and content creation sessions, not for studio rentals.");
  else if (row.kind === "free_hour") restrictions.push("For one hour of one studio's rental: not for several studios booked together, add-ons, photography or content creation sessions.");
  else if (row.kind === "percent") restrictions.push("Takes its percentage off a studio rental, not off add-ons. Not for photography or content creation sessions.");
  else restrictions.push("Pays for a studio rental and its add-ons. Not for photography or content creation sessions.");
  if (row.email) restrictions.push("Works only with the email address it was sent to.");
  const days = promoDaysInWords(readPromoDays(row.bookingDays));
  if (days) restrictions.push(`For ${days}.`);

  const title =
    row.kind === "amount"
      ? row.source === "reschedule"
        ? "Reschedule code"
        : "Studio credit"
      : row.kind === "free_hour"
        ? "Free studio hour"
        : "Discount code";
  const remaining =
    row.kind === "amount"
      ? `${formatCents(Math.max(0, row.value))} remaining`
      : row.kind === "free_hour"
        ? usesLeft > 1
          ? `${minutesText(row.value)}, usable ${uses(usesLeft)}`
          : minutesText(row.value)
        : usedUp
          ? `${row.value}% off`
          : `${row.value}% off, usable ${uses(usesLeft)}`;

  return {
    code: row.code,
    title,
    status: row.voidedAt ? "cancelled" : usedUp ? "used" : expired ? "expired" : "usable",
    remaining,
    expires: row.expiresAt ? formatDay(row.expiresAt) : null,
    restrictions,
  };
}

/** A booking a code paid for, in part or in whole. */
export interface CodeUse {
  ref: string;
  customerName: string;
  /** ISO: the booking's start. */
  startAt: string;
  status: (typeof bookings.$inferSelect)["status"];
  /** What the code covered of it: "$68", "60 minutes". */
  covered: string;
}

/**
 * The studio's own check of a code (the owner's answer of 2026-11-23: "can we check its balance from admin page?",
 * question 71 in ProjectLibrary.md): the client's check, and what only the studio sees. Whose it is, where it came
 * from, and every booking it paid for. A code the studio cancelled, and a membership never paid for, are found here.
 */
export interface StudioCodeCheck {
  balance: CodeBalance;
  /** The address it works with; null when anyone may use it. */
  whose: string | null;
  origin: "loyalty" | "reschedule" | "manual" | "pet_fee" | "membership";
  /** The booking it was issued for: the visit rewarded, or the booking moved. */
  originRef: string | null;
  /** What a code of credit was worth when it was issued: "$136". */
  issued: string | null;
  /** ISO. */
  madeAt: string;
  /** ISO, when the studio cancelled it. */
  cancelledAt: string | null;
  note: string;
  uses: CodeUse[];
}

export async function studioCodeCheck(db: DbLike, rawCode: unknown, now: Date): Promise<StudioCodeCheck | null> {
  const code = normalizeCode(rawCode);
  if (code.length < 4 || code.length > 40) return null;

  const [member] = await db.select().from(memberships).where(eq(memberships.code, code)).limit(1);
  if (member) {
    const spent = await db
      .select({ ref: bookings.ref, customerName: bookings.customerName, startAt: bookings.startAt, status: bookings.status, minutes: membershipMinutes.minutes })
      .from(membershipMinutes)
      .innerJoin(bookings, eq(bookings.id, membershipMinutes.bookingId))
      .where(and(eq(membershipMinutes.membershipId, member.id), eq(membershipMinutes.kind, "booking")))
      .orderBy(asc(bookings.startAt));
    return {
      balance: await membershipBalance(db, member),
      whose: member.email,
      origin: "membership",
      originRef: null,
      issued: null,
      madeAt: member.createdAt.toISOString(),
      cancelledAt: member.cancelledAt?.toISOString() ?? null,
      note: "",
      uses: spent.map((use) => ({
        ref: use.ref,
        customerName: use.customerName,
        startAt: use.startAt.toISOString(),
        status: use.status,
        covered: `${Math.abs(use.minutes)} minutes`,
      })),
    };
  }

  const [row] = await db.select().from(promoCodes).where(eq(promoCodes.code, code)).limit(1);
  if (!row) return null;
  const [paid, origin] = await Promise.all([
    db
      .select({ ref: bookings.ref, customerName: bookings.customerName, startAt: bookings.startAt, status: bookings.status, cents: bookings.promoDiscountCents })
      .from(bookings)
      .where(eq(bookings.promoCodeId, row.id))
      .orderBy(asc(bookings.startAt)),
    row.originBookingId
      ? db.select({ ref: bookings.ref }).from(bookings).where(eq(bookings.id, row.originBookingId)).limit(1)
      : Promise.resolve([]),
  ]);
  return {
    balance: promoBalance(row, now),
    whose: row.email,
    origin: row.source,
    originRef: origin[0]?.ref ?? null,
    issued: row.kind === "amount" && row.issuedCents !== null ? formatCents(row.issuedCents) : null,
    madeAt: row.createdAt.toISOString(),
    cancelledAt: row.voidedAt?.toISOString() ?? null,
    note: row.note,
    uses: paid.map((use) => ({
      ref: use.ref,
      customerName: use.customerName,
      startAt: use.startAt.toISOString(),
      status: use.status,
      covered: formatCents(use.cents),
    })),
  };
}
