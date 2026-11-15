import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import {
  blocks,
  bookings,
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
import { PG_EXCLUSION_VIOLATION, pgErrorCode, queryRows, type Db, type DbLike } from "@/db/client";
import { isIsoDate, type DayType, type IsoDate } from "@/lib/domain/time";
import { deleteAllSessions, normalizeEmail } from "./auth";
import { toBookingViews, type BookingView } from "./bookings";
import { issuePromo } from "./promos";
import { dayBoundsUtc, localToUtc } from "./tz";

/**
 * Everything only the owner may do. These functions do not check who is
 * calling: every caller in src/app/admin must run `requireOwner()` first.
 */

// ── Staff and shifts ─────────────────────────────────────────────────────────

export interface StaffMember {
  id: string;
  email: string;
  name: string;
  /** Assigned dates from today on. */
  days: IsoDate[];
}

export async function listStaff(db: DbLike, from: IsoDate): Promise<StaffMember[]> {
  const people = await db.select().from(users).where(eq(users.role, "staff")).orderBy(asc(users.email));
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
    days: shifts.filter((s) => s.userId === p.id).map((s) => s.day),
  }));
}

export type AddStaffResult = { ok: true; id: string } | { ok: false; message: string };

/** Give an email address staff access. The person signs in with a code like anyone else. */
export async function addStaff(db: DbLike, rawEmail: unknown, rawName: unknown): Promise<AddStaffResult> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, message: "Enter a valid email address." };
  const name = typeof rawName === "string" ? rawName.trim().slice(0, 120) : "";
  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing?.role === "owner") return { ok: false, message: "That address belongs to an owner." };
  const [row] = await db
    .insert(users)
    .values({ email, name, role: "staff" })
    .onConflictDoUpdate({ target: users.email, set: name ? { role: "staff", name } : { role: "staff" } })
    .returning({ id: users.id });
  return { ok: true, id: row.id };
}

/** Take staff access away at once: role, shifts and open sessions. */
export async function removeStaff(db: Db, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const changed = await tx
      .update(users)
      .set({ role: "customer" })
      .where(and(eq(users.id, userId), eq(users.role, "staff")))
      .returning({ id: users.id });
    if (changed.length === 0) return;
    await tx.delete(staffShifts).where(eq(staffShifts.userId, userId));
    await deleteAllSessions(tx, userId);
  });
}

/** Assign or unassign one date for a staff member. */
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
  if (!Number.isInteger(priceCents) || priceCents < 0 || priceCents > 10_000_000) return false;
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

// ── Blocking time ────────────────────────────────────────────────────────────

export type BlockResult = { ok: true; id: string } | { ok: false; message: string };

/**
 * Take studios off the calendar for a span of one day (maintenance, a private
 * event). Refused if a booking already holds any of that time.
 */
export async function createBlock(
  db: Db,
  input: { studioIds: string[]; date: string; startMinute: number; endMinute: number; note: string },
): Promise<BlockResult> {
  const { studioIds, date, startMinute, endMinute } = input;
  if (!isIsoDate(date)) return { ok: false, message: "Choose a valid date." };
  if (studioIds.length === 0) return { ok: false, message: "Choose at least one studio." };
  if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute) || startMinute < 0 || endMinute > 1440 || startMinute >= endMinute) {
    return { ok: false, message: "The end time must be after the start time." };
  }
  const known = await db.select({ id: studios.id }).from(studios).where(inArray(studios.id, studioIds));
  if (known.length !== new Set(studioIds).size) return { ok: false, message: "Unknown studio." };

  const from = localToUtc(date, startMinute).toISOString();
  const to = localToUtc(date, endMinute).toISOString();
  try {
    const id = await db.transaction(async (tx) => {
      const [block] = await tx.insert(blocks).values({ note: input.note.slice(0, 200) }).returning({ id: blocks.id });
      for (const studioId of [...new Set(studioIds)].sort()) {
        await tx.insert(studioHolds).values({
          studioId,
          blockId: block.id,
          occupied: sql`tstzrange(${from}::timestamptz, ${to}::timestamptz, '[)')`,
        });
      }
      return block.id;
    });
    return { ok: true, id };
  } catch (error) {
    if (pgErrorCode(error) === PG_EXCLUSION_VIOLATION) {
      return { ok: false, message: "A booking or another block already takes part of that time." };
    }
    throw error;
  }
}

export async function removeBlock(db: DbLike, blockId: string): Promise<void> {
  await db.delete(blocks).where(eq(blocks.id, blockId)); // its holds go with it
}

export interface BlockView {
  id: string;
  note: string;
  studios: string[];
  startAt: string;
  endAt: string;
}

export async function listBlocks(db: DbLike, from: Date): Promise<BlockView[]> {
  const rows = await queryRows<{ id: string; note: string; name: string; start_at: string | Date; end_at: string | Date }>(
    db,
    sql`
      select b.id, b.note, s.name, lower(h.occupied) as start_at, upper(h.occupied) as end_at
      from blocks b
      join studio_holds h on h.block_id = b.id and h.active
      join studios s on s.id = h.studio_id
      where upper(h.occupied) > ${from.toISOString()}::timestamptz
      order by lower(h.occupied), s.sort_order
    `,
  );
  const byId = new Map<string, BlockView>();
  for (const row of rows) {
    const existing = byId.get(row.id);
    if (existing) existing.studios.push(row.name);
    else {
      byId.set(row.id, {
        id: row.id,
        note: row.note,
        studios: [row.name],
        startAt: new Date(row.start_at).toISOString(),
        endAt: new Date(row.end_at).toISOString(),
      });
    }
  }
  return [...byId.values()];
}

// ── Bookings ─────────────────────────────────────────────────────────────────

export interface AdminBooking extends BookingView {
  customerPhone: string;
  notes: string;
  /** Card money still held: payments less refunds sent or on their way. */
  cardHeldCents: number;
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
  const paid = await db
    .select({
      bookingId: payments.bookingId,
      paidCents: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int`,
    })
    .from(payments)
    .where(and(inArray(payments.bookingId, ids), eq(payments.status, "succeeded")))
    .groupBy(payments.bookingId);
  const back = await db
    .select({
      bookingId: payments.bookingId,
      status: refunds.status,
      cents: sql<number>`coalesce(sum(${refunds.amountCents}), 0)::int`,
    })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .where(inArray(payments.bookingId, ids))
    .groupBy(payments.bookingId, refunds.status);

  const views = await toBookingViews(db, rows);
  return views.map((view, i) => {
    const refundRows = back.filter((b) => b.bookingId === view.id);
    const returned = refundRows.filter((b) => b.status !== "failed").reduce((sum, b) => sum + b.cents, 0);
    return {
      ...view,
      customerPhone: rows[i].customerPhone,
      notes: rows[i].notes,
      cardHeldCents: (paid.find((p) => p.bookingId === view.id)?.paidCents ?? 0) - returned,
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
    .where(inArray(refunds.status, ["pending", "failed"]))
    .orderBy(desc(refunds.createdAt));
  return rows as RefundProblem[];
}

// ── Codes ────────────────────────────────────────────────────────────────────

export interface CodeView {
  id: string;
  code: string;
  kind: "percent" | "amount";
  value: number;
  source: string;
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
    email: r.email,
    usedCount: r.usedCount,
    maxUses: r.maxUses,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    voided: r.voidedAt !== null,
    note: r.note,
  }));
}

/** Stop a code from being used again. What was already spent stays spent. */
export async function voidCode(db: DbLike, codeId: string, now: Date): Promise<void> {
  await db.update(promoCodes).set({ voidedAt: now }).where(eq(promoCodes.id, codeId));
}

export type CreateCodeResult = { ok: true; code: string } | { ok: false; message: string };

/** A code the owner hands out: a percent discount or an amount of credit. */
export async function createManualCode(
  db: DbLike,
  input: { kind: "percent" | "amount"; value: number; email: string | null; validDays: number; maxUses: number; note: string },
  now: Date,
): Promise<CreateCodeResult> {
  if (input.kind !== "percent" && input.kind !== "amount") return { ok: false, message: "Choose a kind of code." };
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
  const issued = await issuePromo(db, {
    kind: input.kind,
    value: input.value,
    source: "manual",
    email,
    expiresAt: new Date(now.getTime() + input.validDays * 86_400_000),
    maxUses: input.kind === "amount" ? 1_000_000 : input.maxUses,
    note: input.note.slice(0, 200),
  });
  return issued ? { ok: true, code: issued.code } : { ok: false, message: "Could not create the code." };
}

// ── Overview numbers ─────────────────────────────────────────────────────────

export async function countUpcoming(db: DbLike, now: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bookings)
    .where(and(eq(bookings.status, "confirmed"), gte(bookings.startAt, now)));
  return row.n;
}

/** Codes still usable that came from a visit or a move. For the admin overview. */
export async function countLiveCodes(db: DbLike): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(promoCodes)
    .where(and(isNotNull(promoCodes.originBookingId), sql`${promoCodes.voidedAt} is null`));
  return row.n;
}
