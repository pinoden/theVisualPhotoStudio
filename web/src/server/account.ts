import { and, asc, eq, inArray } from "drizzle-orm";
import { bookingEvents } from "@/db/schema";
import type { DbLike } from "@/db/client";
import { LABEL_TEXT } from "@/lib/domain/labels";
import type { LoyaltyStanding } from "@/lib/domain/loyalty";
import { isIsoDate, type IsoDate } from "@/lib/domain/time";
import { listBookingsForEmail, type BookingView } from "./bookings";
import type { MembershipView } from "./memberships";
import type { CustomerCode } from "./promos";
import type { Reward } from "./rewards";
import { localDateOf } from "./tz";

/**
 * A customer's own appointments, for their account: what is still to come and
 * what is past, with the words a customer reads for each status. Everything
 * here is found by the email address the person signed in with, which the
 * sign-in code proved is theirs, so nobody is shown another person's bookings.
 */

export interface AccountBooking extends BookingView {
  /**
   * The times the studio moved this booking, oldest first, in words: "Moved
   * from Wed, Nov 18, 2026, 10:00 AM to Thu, Nov 19, 2026, 2:00 PM". The
   * booking keeps its reference and its history when it is moved.
   */
  moves: string[];
}

/** The statuses a past appointment can be filtered by. */
export const PAST_STATUSES = {
  completed: "Completed",
  cancelled: "Cancelled",
  rescheduled: "Rescheduled",
  missed: "Missed",
} as const;
export type PastStatus = keyof typeof PAST_STATUSES;

function isPastStatus(value: unknown): value is PastStatus {
  return typeof value === "string" && Object.hasOwn(PAST_STATUSES, value);
}

/** The status of a booking in a customer's words, and the badge that goes with it. */
export function customerStatus(booking: Pick<BookingView, "status" | "cancelReason" | "label">): { text: string; badge: string } {
  if (booking.status === "cancelled" && booking.cancelReason === "rescheduled") {
    return { text: "Released for rescheduling", badge: "rescheduled" };
  }
  if (booking.status === "no_show") return { text: "Missed", badge: "no_show" };
  return { text: LABEL_TEXT[booking.label], badge: booking.label };
}

/** Which of the filter's statuses a past booking falls under. A booking the studio moved is also "rescheduled". */
function pastStatusesOf(booking: AccountBooking): PastStatus[] {
  const found: PastStatus[] = [];
  if (booking.status === "completed") found.push("completed");
  if (booking.status === "no_show") found.push("missed");
  if (booking.status === "cancelled" && booking.cancelReason !== "rescheduled") found.push("cancelled");
  if ((booking.status === "cancelled" && booking.cancelReason === "rescheduled") || booking.moves.length > 0 || booking.label === "rescheduled") {
    found.push("rescheduled");
  }
  return found;
}

/**
 * Every booking made with an email address, split into what is still to come
 * (confirmed, and not yet over; soonest first) and everything else (newest
 * first). Abandoned checkouts are not bookings and are left out.
 */
export async function loadAppointments(db: DbLike, email: string, now: Date): Promise<{ upcoming: AccountBooking[]; past: AccountBooking[] }> {
  const all = await listBookingsForEmail(db, email);
  const moved =
    all.length > 0
      ? await db
          .select({ bookingId: bookingEvents.bookingId, note: bookingEvents.note })
          .from(bookingEvents)
          .where(
            and(
              inArray(
                bookingEvents.bookingId,
                all.map((booking) => booking.id),
              ),
              eq(bookingEvents.toLabel, "rescheduled"),
            ),
          )
          .orderBy(asc(bookingEvents.at), asc(bookingEvents.recordedAt))
      : [];
  const withMoves: AccountBooking[] = all.map((booking) => ({
    ...booking,
    moves: moved.filter((event) => event.bookingId === booking.id && event.note.startsWith("Moved from")).map((event) => event.note.replace(/, at the client's request$/, "")),
  }));
  const isUpcoming = (booking: BookingView) => booking.status === "confirmed" && new Date(booking.endAt).getTime() > now.getTime();
  return {
    upcoming: withMoves.filter(isUpcoming).reverse(),
    past: withMoves.filter((booking) => !isUpcoming(booking)),
  };
}

export interface PastFilter {
  /** Studio-local dates, inclusive. */
  from?: IsoDate;
  to?: IsoDate;
  /** A studio's name. */
  studio?: string;
  status?: PastStatus;
}

/** Read a filter from a page's address. Anything that is not understood is left out, never guessed. */
export function parsePastFilter(query: Record<string, string | string[] | undefined>): PastFilter {
  const text = (key: string) => (typeof query[key] === "string" ? (query[key] as string).trim() : "");
  const from = text("from");
  const to = text("to");
  const status = text("status");
  const studio = text("studio").slice(0, 100);
  return {
    ...(isIsoDate(from) ? { from } : {}),
    ...(isIsoDate(to) ? { to } : {}),
    ...(studio ? { studio } : {}),
    ...(isPastStatus(status) ? { status } : {}),
  };
}

export function filterPast(past: AccountBooking[], filter: PastFilter): AccountBooking[] {
  return past.filter((booking) => {
    const day = localDateOf(new Date(booking.startAt));
    if (filter.from && day < filter.from) return false;
    if (filter.to && day > filter.to) return false;
    if (filter.studio && !booking.studios.some((studio) => studio.name === filter.studio)) return false;
    if (filter.status && !pastStatusesOf(booking).includes(filter.status)) return false;
    return true;
  });
}

/** The studios a customer has past bookings in, by name, for the filter's list. */
export function studiosOf(bookings: AccountBooking[]): string[] {
  return [...new Set(bookings.flatMap((booking) => booking.studios.map((studio) => studio.name)))].sort();
}

/**
 * What a client holds, at a glance (the owner's answer of 2026-11-23 on loyalty: "everything reasonable: balance,
 * hours, etc", question 72 in ProjectLibrary.md): the free hours they can use, the credit left on their codes, the
 * discount codes still usable, and their membership's hours. From what the account's pages read already.
 */
export interface AtAGlance {
  freeHours: number;
  /** ISO: when the free hour that ends soonest ends; null when none of them ends. */
  firstFreeHourEnds: string | null;
  /** Credit for studio rentals and their add-ons, in cents. */
  creditCents: number;
  /** Credit for photography sessions only, in cents. */
  photoCreditCents: number;
  discounts: number;
  /** Membership minutes left, every membership that can still be used. */
  membershipMinutes: number;
}

export function atAGlance(
  rewards: Pick<Reward, "status" | "expiresAt">[],
  codes: Pick<CustomerCode, "kind" | "value" | "photographyOnly">[],
  memberships: Pick<MembershipView, "status" | "minutesLeft">[],
): AtAGlance {
  const usable = rewards.filter((reward) => reward.status === "available");
  const ends = usable.map((reward) => reward.expiresAt).filter((end): end is string => end !== null).sort();
  const credit = (photography: boolean) =>
    codes.filter((code) => code.kind === "amount" && code.photographyOnly === photography).reduce((sum, code) => sum + Math.max(0, code.value), 0);
  return {
    freeHours: usable.length,
    firstFreeHourEnds: ends[0] ?? null,
    creditCents: credit(false),
    photoCreditCents: credit(true),
    discounts: codes.filter((code) => code.kind === "percent").length,
    membershipMinutes: memberships.filter((membership) => membership.status !== "starting").reduce((sum, membership) => sum + Math.max(0, membership.minutesLeft), 0),
  };
}

/** The bookings whose day gave a loyalty stamp, and those whose stamp completed a free hour (question 72). */
export interface VisitStamps {
  stamped: Set<string>;
  completed: Set<string>;
}

export function visitStamps(standing: Pick<LoyaltyStanding, "days" | "milestones"> | null): VisitStamps | null {
  if (!standing) return null;
  return {
    stamped: new Set(standing.days.map((entry) => entry.bookingId)),
    completed: new Set(standing.milestones.filter((id): id is string => id !== null)),
  };
}
