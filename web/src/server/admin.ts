import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import {
  addons,
  bookings,
  loyaltyLedger,
  payments,
  priceRules,
  promoCodes,
  refunds,
  specialDates,
  staffShifts,
  studioHolds,
  studioHours,
  studios,
  users,
} from "@/db/schema";
import { together, type Db, type DbLike } from "@/db/client";
import { isAdminLevel, type AdminLevel } from "@/lib/abilities";
import { isAddonKind, type AddonKind } from "@/lib/addon-kinds";
import type { PromoKind } from "@/lib/domain/pricing";
import { isIsoDate, type DayType, type IsoDate } from "@/lib/domain/time";
import { PROMO_CODE_RULE } from "@/lib/parse";
import { MANUAL_PROVIDER } from "@/lib/payment-methods";
import { parseStudioFacts, type StudioFacts } from "@/lib/studio-facts";
import { deleteAllSessions, normalizeEmail } from "./auth";
import { toBookingViews, type BookingView } from "./bookings";
import { handPaidByBooking } from "./money";
import { issuePromo, looksSiteMade, normalizeCode } from "./promos";
import { dayBoundsUtc } from "./tz";

/**
 * Everything only the owner may do. These functions do not check who is
 * calling: every caller in src/app/admin must run `requireOwner()` first.
 */

// ── Staff and shifts ─────────────────────────────────────────────────────────

export interface StaffMember {
  id: string;
  email: string;
  name: string;
  /** Studio Manager or Studio Attendant. */
  level: AdminLevel;
  /** Assigned dates from today on. Only an attendant's matter: a manager sees every day. */
  days: IsoDate[];
}

/** Everyone who works in the admin below the owners: managers first, then attendants, by email. */
export async function listStaff(db: DbLike, from: IsoDate): Promise<StaffMember[]> {
  const people = (await db.select().from(users).where(inArray(users.role, ["staff", "manager"])).orderBy(asc(users.email))).sort(
    (a, b) => Number(b.role === "manager") - Number(a.role === "manager"),
  );
  if (people.length === 0) return [];
  const shifts = await db
    .select()
    .from(staffShifts)
    .where(
      and(
        inArray(
          staffShifts.userId,
          people.map((p) => p.id),
        ),
        gte(staffShifts.day, from),
      ),
    )
    .orderBy(asc(staffShifts.day));
  return people.map((p) => ({
    id: p.id,
    email: p.email,
    name: p.name,
    level: p.role === "manager" ? "manager" : "staff",
    days: shifts.filter((s) => s.userId === p.id).map((s) => s.day),
  }));
}

export type AddStaffResult = { ok: true; id: string } | { ok: false; message: string };

/**
 * Give an email address access to the admin, as a Studio Attendant or a
 * Studio Manager. The person signs in with a code like anyone else.
 */
export async function addStaff(db: DbLike, rawEmail: unknown, rawName: unknown, level: AdminLevel = "staff"): Promise<AddStaffResult> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, message: "Enter a valid email address." };
  if (!isAdminLevel(level)) return { ok: false, message: "Choose Studio Manager or Studio Attendant." };
  const name = typeof rawName === "string" ? rawName.trim().slice(0, 120) : "";
  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing?.role === "owner") return { ok: false, message: "That address belongs to an owner." };
  const [row] = await db
    .insert(users)
    .values({ email, name, role: level })
    .onConflictDoUpdate({ target: users.email, set: name ? { role: level, name } : { role: level } })
    .returning({ id: users.id });
  return { ok: true, id: row.id };
}

/**
 * Make an attendant a manager, or a manager an attendant. It applies at their
 * next request: nobody has to sign in again. The days assigned to them stay
 * on record, and matter again if a manager becomes an attendant.
 */
export async function setStaffLevel(db: DbLike, userId: string, level: unknown): Promise<boolean> {
  if (!isAdminLevel(level) || !UUID.test(userId)) return false;
  const changed = await db
    .update(users)
    .set({ role: level })
    .where(and(eq(users.id, userId), inArray(users.role, ["staff", "manager"])))
    .returning({ id: users.id });
  return changed.length === 1;
}

/** Take admin access away at once, from an attendant or a manager: role, shifts and open sessions. */
export async function removeStaff(db: Db, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const changed = await tx
      .update(users)
      .set({ role: "customer" })
      .where(and(eq(users.id, userId), inArray(users.role, ["staff", "manager"])))
      .returning({ id: users.id });
    if (changed.length === 0) return;
    await tx.delete(staffShifts).where(eq(staffShifts.userId, userId));
    await deleteAllSessions(tx, userId);
  });
}

/** Assign or unassign one date for an attendant. A manager sees every day, so has none assigned. */
export async function setShift(db: DbLike, userId: string, day: string, assigned: boolean): Promise<boolean> {
  if (!isIsoDate(day)) return false;
  const [person] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  if (person?.role !== "staff") return false;
  if (assigned) await db.insert(staffShifts).values({ userId, day }).onConflictDoNothing();
  else await db.delete(staffShifts).where(and(eq(staffShifts.userId, userId), eq(staffShifts.day, day)));
  return true;
}

// ── Prices ───────────────────────────────────────────────────────────────────

/**
 * Set, change or remove (priceCents null) the price of one studio for one
 * duration on weekdays or weekends. Removing a price makes that duration
 * unbookable for the studio on that kind of day.
 */
/** The most a price can be: $100,000. */
export const PRICE_MAX_CENTS = 10_000_000;

export async function savePrice(
  db: DbLike,
  input: { studioId: string; dayType: DayType; durationMinutes: number; priceCents: number | null },
): Promise<boolean> {
  const { studioId, dayType, durationMinutes, priceCents } = input;
  if (dayType !== "weekday" && dayType !== "weekend") return false;
  if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 1440 || durationMinutes % 15 !== 0) return false;
  const [studio] = await db.select({ id: studios.id }).from(studios).where(eq(studios.id, studioId)).limit(1);
  if (!studio) return false;

  if (priceCents === null) {
    await db
      .delete(priceRules)
      .where(and(eq(priceRules.studioId, studioId), eq(priceRules.dayType, dayType), eq(priceRules.durationMinutes, durationMinutes)));
    return true;
  }
  if (!Number.isInteger(priceCents) || priceCents < 0 || priceCents > PRICE_MAX_CENTS) return false;
  await db
    .insert(priceRules)
    .values({ studioId, dayType, durationMinutes, priceCents })
    .onConflictDoUpdate({
      target: [priceRules.studioId, priceRules.dayType, priceRules.durationMinutes],
      set: { priceCents },
    });
  return true;
}

/** Price a date as a weekend or weekday regardless of the calendar, or clear that (dayType null). */
export async function setSpecialDate(db: DbLike, day: string, dayType: DayType | null, note = ""): Promise<boolean> {
  if (!isIsoDate(day)) return false;
  if (dayType === null) {
    await db.delete(specialDates).where(eq(specialDates.day, day));
    return true;
  }
  if (dayType !== "weekday" && dayType !== "weekend") return false;
  await db
    .insert(specialDates)
    .values({ day, dayType, note: note.slice(0, 200) })
    .onConflictDoUpdate({ target: specialDates.day, set: { dayType, note: note.slice(0, 200) } });
  return true;
}

/** Opening hours for one weekday; `hours` null means closed that day. */
export async function saveStudioHours(
  db: DbLike,
  studioId: string,
  weekday: number,
  hours: { openMinute: number; closeMinute: number } | null,
): Promise<boolean> {
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) return false;
  if (hours === null) {
    await db.delete(studioHours).where(and(eq(studioHours.studioId, studioId), eq(studioHours.weekday, weekday)));
    return true;
  }
  const { openMinute, closeMinute } = hours;
  if (!Number.isInteger(openMinute) || !Number.isInteger(closeMinute)) return false;
  if (openMinute < 0 || closeMinute > 1440 || openMinute >= closeMinute) return false;
  const [studio] = await db.select({ id: studios.id }).from(studios).where(eq(studios.id, studioId)).limit(1);
  if (!studio) return false;
  await db
    .insert(studioHours)
    .values({ studioId, weekday, openMinute, closeMinute })
    .onConflictDoUpdate({ target: [studioHours.studioId, studioHours.weekday], set: { openMinute, closeMinute } });
  return true;
}

// Blocking time: src/server/blocked-time.ts (Availability & Blocked Time).

// ── Bookings ─────────────────────────────────────────────────────────────────

export interface AdminBooking extends BookingView {
  customerPhone: string;
  notes: string;
  /** Card money still held: payments less every refund recorded, made, on its way or owed (one that failed is tried again). */
  cardHeldCents: number;
  /** What the studio can still send back to the card: what it holds, less a pet fee already returned as studio credit. */
  refundableCents: number;
  /**
   * Money recorded by hand and not given back, taken at the studio or paid through Acuity before this website: the site
   * cannot send it anywhere, the studio gives it back by hand.
   */
  studioHeldCents: number;
  /** Where that money was paid, in words (`handPaidByBooking`): "at the studio", "through Acuity", or both. */
  studioHeldPlace: string;
  /**
   * For a booking released for a reschedule code: the code its money went into, what is left on it, and whether an
   * owner cancelled it. A refund comes off it; what was spent of it cannot come back.
   */
  rescheduleCode: { code: string; valueCents: number; voided: boolean } | null;
  refundProblem: boolean;
}

/** Bookings that start within [from, to] (studio-local dates), earliest first. */
export async function listBookings(
  db: DbLike,
  range: { from: string; to: string },
  options: { includeCancelled?: boolean } = {},
): Promise<AdminBooking[]> {
  if (!isIsoDate(range.from) || !isIsoDate(range.to) || range.to < range.from) return [];
  const start = dayBoundsUtc(range.from).start;
  const end = dayBoundsUtc(range.to).end;
  const statuses = options.includeCancelled
    ? (["confirmed", "completed", "no_show", "cancelled"] as const)
    : (["confirmed", "completed", "no_show"] as const);
  const rows = await db
    .select()
    .from(bookings)
    .where(and(gte(bookings.startAt, start), lt(bookings.startAt, end), inArray(bookings.status, [...statuses])))
    .orderBy(asc(bookings.startAt))
    .limit(500);
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const [paid, back, codes, byHand, petReturned, views] = await together(db, [
    () =>
      db
        .select({
          bookingId: payments.bookingId,
          paidCents: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int`,
        })
        .from(payments)
        // Card money charged through the site only: what was taken at the studio cannot be refunded from here.
        .where(and(inArray(payments.bookingId, ids), eq(payments.status, "succeeded"), ne(payments.provider, MANUAL_PROVIDER)))
        .groupBy(payments.bookingId),
    () =>
      db
        .select({
          bookingId: payments.bookingId,
          status: refunds.status,
          cents: sql<number>`coalesce(sum(${refunds.amountCents}), 0)::int`,
        })
        .from(refunds)
        .innerJoin(payments, eq(payments.id, refunds.paymentId))
        .where(and(inArray(payments.bookingId, ids), ne(payments.provider, MANUAL_PROVIDER)))
        .groupBy(payments.bookingId, refunds.status),
    // The reschedule codes the money of released bookings went into, cancelled by an owner or not: what was spent of
    // a code cannot come back, and what is left is that money still.
    () =>
      db
        .select({ bookingId: promoCodes.originBookingId, code: promoCodes.code, valueCents: promoCodes.value, voidedAt: promoCodes.voidedAt })
        .from(promoCodes)
        .where(and(inArray(promoCodes.originBookingId, ids), eq(promoCodes.source, "reschedule"))),
    // Money recorded by hand, less what the studio gave back by hand, and where it was paid.
    () => handPaidByBooking(db, ids),
    // The pet fees already returned as studio credit (see src/server/pet-fee.ts), for what each credit was issued for,
    // which can be part of the fee: not to be refunded to the card or by hand as well.
    () =>
      db
        .select({ bookingId: promoCodes.originBookingId, cents: sql<number>`coalesce(${promoCodes.issuedCents}, ${promoCodes.value})::int` })
        .from(promoCodes)
        .where(and(inArray(promoCodes.originBookingId, ids), eq(promoCodes.source, "pet_fee"))),
    () => toBookingViews(db, rows),
  ]);
  return views.map((view, i) => {
    const refundRows = back.filter((b) => b.bookingId === view.id);
    const returned = refundRows.reduce((sum, b) => sum + b.cents, 0);
    const cardHeldCents = (paid.find((p) => p.bookingId === view.id)?.paidCents ?? 0) - returned;
    const asCredit = Math.min(Math.max(0, cardHeldCents), petReturned.find((p) => p.bookingId === view.id)?.cents ?? 0);
    const code = codes.find((row) => row.bookingId === view.id);
    const hand = byHand.get(view.id);
    return {
      ...view,
      customerPhone: rows[i].customerPhone,
      notes: rows[i].notes,
      cardHeldCents,
      // A released booking's money is on its code: no more than is left there can be refunded.
      refundableCents: Math.min(Math.max(0, cardHeldCents - asCredit), code?.valueCents ?? Infinity),
      // The pet fee returned as credit that the card did not hold comes off what the studio gives back by hand.
      studioHeldCents: Math.min(
        Math.max(0, (hand?.cents ?? 0) - ((petReturned.find((p) => p.bookingId === view.id)?.cents ?? 0) - asCredit)),
        code?.valueCents ?? Infinity,
      ),
      studioHeldPlace: hand?.place ?? "at the studio",
      rescheduleCode: code ? { code: code.code, valueCents: code.valueCents, voided: code.voidedAt !== null } : null,
      refundProblem: refundRows.some((b) => b.status === "failed"),
    };
  });
}

export interface RefundProblem {
  refundId: string;
  ref: string;
  customerName: string;
  amountCents: number;
  status: "pending" | "failed";
  error: string | null;
}

/** Refunds that have not reached the customer yet. The owner should see these first. */
export async function listRefundProblems(db: DbLike): Promise<RefundProblem[]> {
  const rows = await db
    .select({
      refundId: refunds.id,
      ref: bookings.ref,
      customerName: bookings.customerName,
      amountCents: refunds.amountCents,
      status: refunds.status,
      error: refunds.error,
    })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    // Refunds of payments that were taken: a refund is only ever made of one.
    .where(and(inArray(refunds.status, ["pending", "failed"]), eq(payments.status, "succeeded")))
    .orderBy(desc(refunds.createdAt));
  return rows as RefundProblem[];
}

// ── Codes ────────────────────────────────────────────────────────────────────

export interface CodeView {
  id: string;
  code: string;
  kind: PromoKind;
  value: number;
  source: string;
  photographyOnly: boolean;
  email: string | null;
  usedCount: number;
  maxUses: number;
  expiresAt: string | null;
  voided: boolean;
  note: string;
}

export async function listCodes(db: DbLike, limit = 200): Promise<CodeView[]> {
  const rows = await db.select().from(promoCodes).orderBy(desc(promoCodes.createdAt)).limit(limit);
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    kind: r.kind,
    value: r.value,
    source: r.source,
    photographyOnly: r.photographyOnly,
    email: r.email,
    usedCount: r.usedCount,
    maxUses: r.maxUses,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    voided: r.voidedAt !== null,
    note: r.note,
  }));
}

/**
 * Stop a code from being used again. What was already spent stays spent. A
 * customer's reward (a free hour that is theirs) cancelled here gets the same
 * line in the loyalty ledger as one cancelled on the customer's page, with
 * `actor`, so that its history says who cancelled it.
 */
export async function voidCode(db: DbLike, codeId: string, now: Date, actor = "an owner"): Promise<void> {
  const [code] = await db
    .update(promoCodes)
    .set({ voidedAt: now })
    .where(and(eq(promoCodes.id, codeId), sql`${promoCodes.voidedAt} is null`))
    .returning({ id: promoCodes.id, kind: promoCodes.kind, email: promoCodes.email });
  if (code && code.kind === "free_hour" && code.email) {
    await db.insert(loyaltyLedger).values({
      email: code.email,
      kind: "reward_cancelled",
      codeId: code.id,
      reason: "Cancelled on the Codes page",
      actor,
      createdAt: now,
    });
  }
}

export type CreateCodeResult = { ok: true; code: string } | { ok: false; message: string };

/**
 * A code the owner hands out: a percent discount, an amount of credit, or a
 * free hour (`value` is then the free minutes, 60), for example for a regular
 * whose visits were made before the site counted them. Its text is the one the
 * owner names (`code`, kept in capitals, as checkout reads what a client
 * types), or one the site makes up when they leave it empty.
 */
export async function createManualCode(
  db: DbLike,
  input: { kind: PromoKind; value: number; email: string | null; validDays: number; maxUses: number; note: string; photographyOnly?: boolean; code?: string },
  now: Date,
): Promise<CreateCodeResult> {
  if (input.kind !== "percent" && input.kind !== "amount" && input.kind !== "free_hour") {
    return { ok: false, message: "Choose a kind of code." };
  }
  if (input.photographyOnly && input.kind !== "percent") {
    return { ok: false, message: "Only percentage discounts can be created for photography sessions." };
  }
  if (!Number.isInteger(input.value) || input.value <= 0) return { ok: false, message: "Enter a value above zero." };
  if (input.kind === "percent" && input.value > 100) return { ok: false, message: "A discount cannot exceed 100%." };
  if (!Number.isInteger(input.validDays) || input.validDays < 1 || input.validDays > 730) {
    return { ok: false, message: "Validity must be between 1 and 730 days." };
  }
  if (!Number.isInteger(input.maxUses) || input.maxUses < 1 || input.maxUses > 100_000) {
    return { ok: false, message: "Uses must be between 1 and 100,000." };
  }
  let email: string | null = null;
  if (input.email && input.email.trim() !== "") {
    email = normalizeEmail(input.email);
    if (!email) return { ok: false, message: "Enter a valid email address, or leave it empty." };
  }
  const named = normalizeCode(input.code ?? "");
  if (named !== "" && !PROMO_CODE_RULE.test(named)) {
    return { ok: false, message: "A code is 3 to 30 letters, digits or hyphens, and starts and ends with a letter or a digit." };
  }
  if (looksSiteMade(named)) {
    return { ok: false, message: "That looks like a code the site makes itself, such as VS-2345-6789. Choose another." };
  }
  const issued = await issuePromo(db, {
    ...(named !== "" ? { code: named } : {}),
    kind: input.kind,
    value: input.value,
    source: "manual",
    photographyOnly: input.photographyOnly,
    email,
    expiresAt: new Date(now.getTime() + input.validDays * 86_400_000),
    // Credit is limited by the money left on it. A free hour is a reward, and a reward is used once.
    maxUses: input.kind === "amount" ? 1_000_000 : input.kind === "free_hour" ? 1 : input.maxUses,
    note: input.note.slice(0, 200),
    issuedAt: now,
  });
  if (issued) return { ok: true, code: issued.code };
  // Cancelled and expired codes keep their text, so a name used once is taken for good.
  return { ok: false, message: named !== "" ? `The code ${named} already exists. Choose another.` : "Could not create the code." };
}

// ── Overview numbers ─────────────────────────────────────────────────────────

export async function countUpcoming(db: DbLike, now: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bookings)
    .where(and(eq(bookings.status, "confirmed"), gte(bookings.startAt, now)));
  return row.n;
}

// ── Studios and add-ons ──────────────────────────────────────────────────────

/** The longest name a studio can have. */
export const STUDIO_NAME_MAX = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StudioDetails {
  /**
   * Its name, as every page, email and receipt shows it (question 29, answered 2026-11-18: the owners rename a studio
   * without a deployment). Left out, it stays as it is. Its address on the site (`slug`) stays, so links keep working.
   */
  name?: string;
  tagline: string;
  description: string;
  /** Guests included in the price. Shown to customers; not enforced. */
  includedGuests: number;
  /** Guests that can come beyond those, each paid as an extra guest. Left out, it stays as it is. */
  extraGuests?: number;
  /** Clean-up minutes kept free after each booking. */
  bufferMinutes: number;
  /** Its facts, but the floor plan, which is chosen on its own (`setStudioFloorPlan`). Text the limits do not take is cut. */
  facts?: Omit<StudioFacts, "floorPlan">;
}

/**
 * Change what the site says about a studio, how many guests its price
 * includes, and its clean-up time. A new clean-up time applies to bookings
 * made from then on: existing bookings keep the time already held for them.
 */
export async function saveStudioDetails(db: DbLike, studioId: string, input: StudioDetails): Promise<boolean> {
  const name = input.name?.replace(/\s+/g, " ").trim();
  if (name !== undefined && (name.length < 1 || name.length > STUDIO_NAME_MAX)) return false;
  const tagline = input.tagline.trim();
  const description = input.description.trim();
  if (!UUID.test(studioId) || tagline.length > 200 || description.length > 2000) return false;
  if (!Number.isInteger(input.includedGuests) || input.includedGuests < 1 || input.includedGuests > 100) return false;
  if (!Number.isInteger(input.bufferMinutes) || input.bufferMinutes < 0 || input.bufferMinutes > 240) return false;
  if (input.extraGuests !== undefined && (!Number.isInteger(input.extraGuests) || input.extraGuests < 0 || input.extraGuests > 100)) return false;
  const [current] = await db.select({ facts: studios.facts }).from(studios).where(eq(studios.id, studioId)).limit(1);
  if (!current) return false;
  if (name !== undefined) {
    // Two studios of one name could not be told apart on the booking screen or in the calendar.
    const [taken] = await db
      .select({ id: studios.id })
      .from(studios)
      .where(and(sql`lower(${studios.name}) = ${name.toLowerCase()}`, ne(studios.id, studioId)))
      .limit(1);
    if (taken) return false;
  }
  // The floor plan stays as it was: it is chosen on its own.
  const facts = input.facts ? parseStudioFacts({ ...input.facts, floorPlan: parseStudioFacts(current.facts).floorPlan }) : parseStudioFacts(current.facts);
  const updated = await db
    .update(studios)
    .set({
      ...(name !== undefined ? { name } : {}),
      tagline,
      description,
      includedGuests: input.includedGuests,
      ...(input.extraGuests !== undefined ? { extraGuests: input.extraGuests } : {}),
      bufferMinutes: input.bufferMinutes,
      facts,
    })
    .where(eq(studios.id, studioId))
    .returning({ id: studios.id });
  return updated.length === 1;
}

export type StudioActiveResult = { ok: true } | { ok: false; code: "unknown" } | { ok: false; code: "booked"; bookings: number };

/**
 * Take a studio off the site, or put it back (question 29, answered 2026-11-18: the owners remove a studio without a
 * deployment). Off the site, it is offered nowhere: not on the booking screen, in the calendar's new bookings, the
 * website's studio blocks or the prices; its past bookings, receipts and history keep it. It is not deleted, so it can
 * come back as it was. While a booking still to come holds it, it stays: those are moved or cancelled first.
 */
export async function setStudioActive(db: DbLike, studioId: string, active: boolean, now: Date): Promise<StudioActiveResult> {
  if (!UUID.test(studioId)) return { ok: false, code: "unknown" };
  if (!active) {
    const [{ n }] = await db
      .select({ n: sql<number>`count(distinct ${studioHolds.bookingId})::int` })
      .from(studioHolds)
      .innerJoin(bookings, eq(bookings.id, studioHolds.bookingId))
      .where(and(eq(studioHolds.studioId, studioId), eq(studioHolds.active, true), sql`upper(${studioHolds.occupied}) > ${now}`, inArray(bookings.status, ["confirmed", "pending_payment"])));
    if (n > 0) return { ok: false, code: "booked", bookings: n };
  }
  const updated = await db.update(studios).set({ active }).where(eq(studios.id, studioId)).returning({ id: studios.id });
  return updated.length === 1 ? { ok: true } : { ok: false, code: "unknown" };
}

/** The studios taken off the site, for the owners to put back. */
export async function listInactiveStudios(db: DbLike): Promise<{ id: string; name: string; slug: string }[]> {
  return db.select({ id: studios.id, name: studios.name, slug: studios.slug }).from(studios).where(eq(studios.active, false)).orderBy(asc(studios.sortOrder), asc(studios.name));
}

export interface AddonInput {
  name: string;
  description: string;
  priceCents: number;
  /** What it is for: see ADDON_KINDS. */
  kind: AddonKind;
  /** null = any booking; otherwise only bookings that include this studio. */
  studioId: string | null;
  /** How many of a prop there are, which overlapping bookings share (src/server/props.ts); null for no such limit. */
  stock?: number | null;
}

export interface AdminAddon extends AddonInput {
  id: string;
  slug: string;
  /** False when it is no longer offered. */
  active: boolean;
  /** Its picture's id in the media library, or null (Props & Resources). */
  mediaId: string | null;
  /** The days a prop is away, both included, or null (Props & Resources). */
  awayFrom: string | null;
  awayTo: string | null;
}

/** Every add-on, including the ones no longer offered. */
export async function listAddons(db: DbLike): Promise<AdminAddon[]> {
  const rows = await db.select().from(addons).orderBy(asc(addons.sortOrder), asc(addons.name));
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    priceCents: row.priceCents,
    kind: row.kind,
    studioId: row.studioId,
    stock: row.stock,
    active: row.active,
    mediaId: row.mediaId,
    awayFrom: row.awayFrom,
    awayTo: row.awayTo,
  }));
}

export type SaveAddonResult = { ok: true; id: string } | { ok: false; message: string };

/**
 * Change an add-on, or create one when `addonId` is null. Bookings already
 * made keep the name and price they were made with.
 *
 * An add-on is taken once per booking: the booking screen offers a tick box,
 * not a quantity, so the table's `max_quantity` stays at its default of 1 and
 * is not something the owner sets.
 */
export async function saveAddon(db: DbLike, addonId: string | null, input: AddonInput): Promise<SaveAddonResult> {
  const name = input.name.replace(/\s+/g, " ").trim();
  const description = input.description.trim();
  if (name.length < 1 || name.length > 80) return { ok: false, message: "Give the add-on a name of up to 80 characters." };
  if (description.length > 300) return { ok: false, message: "Keep the description under 300 characters." };
  if (!Number.isInteger(input.priceCents) || input.priceCents < 0 || input.priceCents > 10_000_000) {
    return { ok: false, message: "Enter the price as an amount, for example 40 or 40.50." };
  }
  if (!isAddonKind(input.kind)) return { ok: false, message: "Choose what the add-on is for." };
  if (input.studioId !== null) {
    const [studio] = UUID.test(input.studioId)
      ? await db.select({ id: studios.id }).from(studios).where(eq(studios.id, input.studioId)).limit(1)
      : [];
    if (!studio) return { ok: false, message: "Unknown studio." };
  }
  const stock = input.stock ?? null;
  if (stock !== null && (!Number.isInteger(stock) || stock < 1 || stock > 100)) {
    return { ok: false, message: "Give how many there are as a whole number from 1 to 100, or leave it empty for no limit." };
  }
  const values = { name, description, priceCents: input.priceCents, kind: input.kind, studioId: input.studioId, stock };

  if (addonId !== null) {
    const updated = UUID.test(addonId)
      ? await db.update(addons).set(values).where(eq(addons.id, addonId)).returning({ id: addons.id })
      : [];
    return updated.length === 1 ? { ok: true, id: addonId } : { ok: false, message: "Unknown add-on." };
  }

  const existing = await db.select({ slug: addons.slug, sortOrder: addons.sortOrder }).from(addons);
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "add-on";
  let slug = base;
  for (let n = 2; existing.some((addon) => addon.slug === slug); n++) slug = `${base}-${n}`;
  const sortOrder = Math.max(-1, ...existing.map((addon) => addon.sortOrder)) + 1;
  const [row] = await db.insert(addons).values({ ...values, slug, sortOrder }).returning({ id: addons.id });
  return { ok: true, id: row.id };
}

/** Offer an add-on, or stop offering it. It is never deleted: past bookings refer to it. */
export async function setAddonActive(db: DbLike, addonId: string, active: boolean): Promise<boolean> {
  if (!UUID.test(addonId)) return false;
  const updated = await db.update(addons).set({ active }).where(eq(addons.id, addonId)).returning({ id: addons.id });
  return updated.length === 1;
}
