import { getDb } from "@/db/client";
import { normalizeEmail } from "@/server/auth";
import { recordCustomerView } from "@/server/customer-views";
import { receiptPdf } from "@/server/receipt-pdf";
import { getReceipt } from "@/server/receipts";
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
 * GET /admin/customers/<email>/receipts/<ref>/pdf: a customer's receipt, for
 * an owner, or a manager who may see customers and money. Anyone else gets
 * "not found".
 */
export async function GET(_request: Request, context: RouteContext<"/admin/customers/[email]/receipts/[ref]/pdf">) {
  const { email: segment, ref } = await context.params;
  const user = await getCurrentUser();
  const email = normalizeEmail(decodeURIComponent(segment));
  if (!user || !(await maySeeReceipts(user)) || !email) return new Response("Not found", { status: 404 });
  const db = await getDb();
  const receipt = await getReceipt(db, email, ref);
  if (!receipt) return new Response("Not found", { status: 404 });
  // The access log (question 27): who downloaded this customer's receipt.
  await recordCustomerView(db, user, email, "receipt", receipt.ref, new Date());
  return new Response(Buffer.from(await receiptPdf(receipt, await loadBusiness(db))), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="receipt-${receipt.ref}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
