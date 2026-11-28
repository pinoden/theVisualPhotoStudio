import { desc, eq, inArray } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { sales, studios } from "@/db/schema";
import { SALE_PERCENT_MAX, type Sale } from "@/lib/domain/sale";
import { addDays, isIsoDate, type IsoDate } from "@/lib/domain/time";

/**
 * The owners' sales (src/lib/domain/sale.ts; question 87 in ProjectLibrary.md): written under Admin → Prices, in
 * force by their own dates, with no deployment. A sale is changed, ended early or deleted at any time: a booking keeps
 * what it was sold at (`bookings.sale`), whatever becomes of the sale.
 */

const NAME_MAX = 60;

const saleOf = (row: typeof sales.$inferSelect): Sale => ({
  id: row.id,
  name: row.name,
  percent: row.percent,
  studioIds: row.studioIds,
  bookFrom: row.bookFrom,
  bookUntil: row.bookUntil,
  visitFrom: row.visitFrom,
  visitUntil: row.visitUntil,
  withCodes: row.withCodes,
});

/** Every sale, the one that ends last first: for the owners' list, and for pricing, which reads their dates itself. */
export async function listSales(db: DbLike): Promise<Sale[]> {
  const rows = await db.select().from(sales).orderBy(desc(sales.bookUntil), desc(sales.createdAt)).limit(200);
  return rows.map(saleOf);
}

export interface SaleInput {
  name: string;
  percent: string;
  studioIds: string[];
  bookFrom: string;
  bookUntil: string;
  visitFrom: string;
  visitUntil: string;
  /** A discount code can be used on top of the sale's price. Left out: it cannot. */
  withCodes?: boolean;
}

export type SaleSaved = { ok: true; id: string } | { ok: false; message: string };

/** Add a sale, or change one. */
export async function saveSale(db: DbLike, id: string | null, input: SaleInput): Promise<SaleSaved> {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > NAME_MAX) return { ok: false, message: `Give the sale a name of 2 to ${NAME_MAX} characters: clients read it.` };
  const percent = /^\d{1,2}$/.test(input.percent.trim()) ? Number(input.percent.trim()) : NaN;
  if (!(percent >= 1 && percent <= SALE_PERCENT_MAX)) return { ok: false, message: `Enter what comes off as a whole percentage from 1 to ${SALE_PERCENT_MAX}.` };
  if (!isIsoDate(input.bookFrom) || !isIsoDate(input.bookUntil)) return { ok: false, message: "Choose the first and the last day the sale can be booked." };
  if (input.bookUntil < input.bookFrom) return { ok: false, message: "The last day of the sale must be on or after its first." };
  const visitFrom = input.visitFrom.trim() || null;
  const visitUntil = input.visitUntil.trim() || null;
  if ((visitFrom && !isIsoDate(visitFrom)) || (visitUntil && !isIsoDate(visitUntil))) return { ok: false, message: "Choose valid days for the studio time." };
  if (visitFrom && visitUntil && visitUntil < visitFrom) return { ok: false, message: "The last day of studio time must be on or after the first." };
  if (visitUntil && visitUntil < input.bookFrom) return { ok: false, message: "The studio time would be over before the sale begins." };
  const studioIds = [...new Set(input.studioIds)];
  if (studioIds.length > 0 && (await db.select({ id: studios.id }).from(studios).where(inArray(studios.id, studioIds))).length !== studioIds.length) {
    return { ok: false, message: "Unknown studio." };
  }
  const values = {
    name,
    percent,
    studioIds,
    bookFrom: input.bookFrom as IsoDate,
    bookUntil: input.bookUntil as IsoDate,
    visitFrom: visitFrom as IsoDate | null,
    visitUntil: visitUntil as IsoDate | null,
    withCodes: input.withCodes === true,
  };
  if (id) {
    const changed = await db.update(sales).set(values).where(eq(sales.id, id)).returning({ id: sales.id });
    return changed.length > 0 ? { ok: true, id } : { ok: false, message: "That sale was deleted meanwhile." };
  }
  const [row] = await db.insert(sales).values(values).returning({ id: sales.id });
  return { ok: true, id: row.id };
}

/** End a sale now: yesterday becomes its last day. One that began today, or has not begun, has no yesterday to end on and is deleted instead. */
export async function endSale(db: DbLike, id: string, today: IsoDate): Promise<boolean> {
  const [row] = await db.select().from(sales).where(eq(sales.id, id)).limit(1);
  if (!row) return false;
  if (row.bookFrom >= today) return deleteSale(db, id);
  if (row.bookUntil < today) return true;
  await db.update(sales).set({ bookUntil: addDays(today, -1) }).where(eq(sales.id, id));
  return true;
}

/** Delete a sale. The bookings made under it keep their prices. */
export async function deleteSale(db: DbLike, id: string): Promise<boolean> {
  return (await db.delete(sales).where(eq(sales.id, id)).returning({ id: sales.id })).length > 0;
}
