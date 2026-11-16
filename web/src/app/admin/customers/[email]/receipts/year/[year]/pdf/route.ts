import { getDb } from "@/db/client";
import { normalizeEmail } from "@/server/auth";
import { yearPdf } from "@/server/receipt-pdf";
import { loadReceipts, yearStatement } from "@/server/receipts";
import { getCurrentUser } from "@/server/session";
import { loadSettings } from "@/server/settings";
import { loadBusiness } from "@/server/website";
import { can } from "@/lib/abilities";

/** A customer's receipts are for the owners, and for a manager who may see both customers and money. */
async function maySeeReceipts(user: { role: string }): Promise<boolean> {
  const settings = await loadSettings(await getDb());
  return can(user, "seeCustomers", settings) && can(user, "seePrices", settings);
}

/**
 * GET /admin/customers/<email>/receipts/year/<year>/pdf: every receipt of one
 * of a customer's calendar years in one file, for an owner, or a manager who
 * may see customers and money. Anyone else gets "not found".
 */
export async function GET(_request: Request, context: RouteContext<"/admin/customers/[email]/receipts/year/[year]/pdf">) {
  const { email: segment, year } = await context.params;
  const user = await getCurrentUser();
  const email = normalizeEmail(decodeURIComponent(segment));
  if (!user || !(await maySeeReceipts(user)) || !email || !/^(19|20)\d{2}$/.test(year)) return new Response("Not found", { status: 404 });
  const db = await getDb();
  const { receipts } = await loadReceipts(db, email);
  const statement = yearStatement(receipts, Number(year));
  if (statement.transactions.length === 0) return new Response("Not found", { status: 404 });
  const file = await yearPdf(statement, { name: statement.receipts[0]?.customerName ?? "", email }, await loadBusiness(db));
  return new Response(Buffer.from(file), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="receipts-${year}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
