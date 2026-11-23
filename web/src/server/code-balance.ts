import { asc, eq } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { membershipPlanStudios, memberships, promoCodes, studios } from "@/db/schema";
import { formatCents } from "@/lib/domain/pricing";
import { minutesLeftOf } from "./membership-minutes";
import { normalizeCode } from "./promos";
import { formatDay } from "./tz";

/**
 * "Check Code Balance" on the booking page (the owner's brief of 2026-11-22, item 5): what a code is worth before a
 * booking, by the code alone. It reads and changes nothing: a code is spent only when a booking is made. It says what
 * the code is, whether it can be used, what is left on it, when it ends and what it is for, and never whose it is: no
 * name, and no email address, only that the code works with the address it was sent to. What the builder read into
 * the brief is question 60 in ProjectLibrary.md.
 */

export type CodeStatus = "usable" | "used" | "expired";

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
    const minutesLeft = await minutesLeftOf(db, member.id);
    const covered = await db
      .select({ name: studios.name })
      .from(membershipPlanStudios)
      .innerJoin(studios, eq(studios.id, membershipPlanStudios.studioId))
      .where(eq(membershipPlanStudios.planId, member.planId))
      .orderBy(asc(studios.sortOrder));
    return {
      found: true,
      balance: {
        code,
        title: `Membership: ${member.planName}`,
        status: minutesLeft > 0 ? "usable" : "used",
        remaining: `${minutesLeft} minutes remaining`,
        // Unused hours carry over: a membership's minutes do not end.
        expires: null,
        restrictions: [
          `For studio rentals in ${orList(covered.map((studio) => studio.name))}, not for photography sessions.`,
          "Works only with the email address of the membership.",
        ],
      },
    };
  }

  const [row] = await db.select().from(promoCodes).where(eq(promoCodes.code, code)).limit(1);
  if (!row || row.voidedAt) return { found: false };
  const expired = row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime();
  const usesLeft = Math.max(0, row.maxUses - row.usedCount);
  const usedUp = row.kind === "amount" ? row.value <= 0 : usesLeft === 0;

  const restrictions: string[] = [];
  if (row.photographyOnly) restrictions.push("For photography sessions, not for studio rentals.");
  else if (row.kind === "free_hour") restrictions.push("For one hour of one studio's rental: not for several studios booked together, add-ons or photography sessions.");
  else if (row.kind === "percent") restrictions.push("Takes its percentage off a studio rental, not off add-ons. Not for photography sessions.");
  else restrictions.push("Pays for a studio rental and its add-ons. Not for photography sessions.");
  if (row.email) restrictions.push("Works only with the email address it was sent to.");

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
    found: true,
    balance: {
      code,
      title,
      status: usedUp ? "used" : expired ? "expired" : "usable",
      remaining,
      expires: row.expiresAt ? formatDay(row.expiresAt) : null,
      restrictions,
    },
  };
}
