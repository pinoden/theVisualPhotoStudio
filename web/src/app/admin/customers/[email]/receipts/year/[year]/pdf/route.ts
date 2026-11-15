import { getDb } from "@/db/client";
import { normalizeEmail } from "@/server/auth";
import { yearPdf } from "@/server/receipt-pdf";
import { loadReceipts, yearStatement } from "@/server/receipts";
import { getCurrentUser } from "@/server/session";

/**
 * GET /admin/customers/<email>/receipts/year/<year>/pdf: every receipt of one
 * of a customer's calendar years in one file, for an owner. Anyone else gets
 * "not found".
 */
export async function GET(_request: Request, context: RouteContext<"/admin/customers/[email]/receipts/year/[year]/pdf">) {
  const { email: segment, year } = await context.params;
  const user = await getCurrentUser();
  const email = normalizeEmail(decodeURIComponent(segment));
  if (!user || user.role !== "owner" || !email || !/^(19|20)\d{2}$/.test(year)) return new Response("Not found", { status: 404 });
  const { receipts } = await loadReceipts(await getDb(), email);
  const statement = yearStatement(receipts, Number(year));
  if (statement.transactions.length === 0) return new Response("Not found", { status: 404 });
  const file = await yearPdf(statement, { name: statement.receipts[0]?.customerName ?? "", email });
  return new Response(Buffer.from(file), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="receipts-${year}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
