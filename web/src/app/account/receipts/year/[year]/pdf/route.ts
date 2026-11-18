import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { yearPdf } from "@/server/receipt-pdf";
import { loadReceipts, yearStatement } from "@/server/receipts";
import { getCurrentUser } from "@/server/session";
import { loadBusiness } from "@/server/website";

/**
 * GET /account/receipts/year/<year>/pdf: every receipt of one calendar year
 * in one file, behind a page that sums the year up. For the signed-in
 * customer's own payments only.
 */
export async function GET(request: NextRequest, context: RouteContext<"/account/receipts/year/[year]/pdf">) {
  const { year } = await context.params;
  const user = await getCurrentUser();
  if (!user) {
    const signIn = new URL("/account/sign-in", request.url);
    signIn.searchParams.set("next", "/account/receipts");
    return Response.redirect(signIn, 303);
  }
  if (!/^(19|20)\d{2}$/.test(year)) return new Response("Not found", { status: 404 });
  const db = await getDb();
  const { receipts } = await loadReceipts(db, user.email);
  const statement = yearStatement(receipts, Number(year));
  if (statement.transactions.length === 0) return new Response("Not found", { status: 404 });
  const customer = { name: user.name || statement.receipts[0]?.customerName || "", email: user.email };
  const file = await yearPdf(statement, customer, await loadBusiness(db));
  return new Response(Buffer.from(file), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="receipts-${year}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
