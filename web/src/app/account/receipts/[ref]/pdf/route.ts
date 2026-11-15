import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { receiptPdf } from "@/server/receipt-pdf";
import { getReceipt } from "@/server/receipts";
import { getCurrentUser } from "@/server/session";

/**
 * GET /account/receipts/<ref>/pdf: one receipt as a PDF file, for the signed-in
 * customer it belongs to. Someone who is not signed in is sent to sign in;
 * anyone else's reference answers "not found".
 */
export async function GET(request: NextRequest, context: RouteContext<"/account/receipts/[ref]/pdf">) {
  const { ref } = await context.params;
  const user = await getCurrentUser();
  if (!user) {
    const signIn = new URL("/account/sign-in", request.url);
    signIn.searchParams.set("next", "/account/receipts");
    return Response.redirect(signIn, 303);
  }
  const receipt = await getReceipt(await getDb(), user.email, ref);
  if (!receipt) return new Response("Not found", { status: 404 });
  const file = await receiptPdf(receipt);
  return new Response(Buffer.from(file), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="receipt-${receipt.ref}.pdf"`,
      // A person's payments: never kept by a shared cache.
      "Cache-Control": "private, no-store",
    },
  });
}
