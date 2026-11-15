import { getDb } from "@/db/client";
import { normalizeEmail } from "@/server/auth";
import { receiptPdf } from "@/server/receipt-pdf";
import { getReceipt } from "@/server/receipts";
import { getCurrentUser } from "@/server/session";

/**
 * GET /admin/customers/<email>/receipts/<ref>/pdf: a customer's receipt, for
 * an owner. Anyone else, staff included, gets "not found", as on every page
 * that only the owners may open.
 */
export async function GET(_request: Request, context: RouteContext<"/admin/customers/[email]/receipts/[ref]/pdf">) {
  const { email: segment, ref } = await context.params;
  const user = await getCurrentUser();
  const email = normalizeEmail(decodeURIComponent(segment));
  if (!user || user.role !== "owner" || !email) return new Response("Not found", { status: 404 });
  const receipt = await getReceipt(await getDb(), email, ref);
  if (!receipt) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(await receiptPdf(receipt)), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="receipt-${receipt.ref}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
