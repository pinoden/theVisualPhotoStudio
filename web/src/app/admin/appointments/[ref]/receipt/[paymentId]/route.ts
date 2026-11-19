import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { cardReceiptOf } from "@/server/appointments";
import { resolvePayments } from "@/server/payments";
import { getCurrentUser } from "@/server/session";

/**
 * GET /admin/appointments/<ref>/receipt/<payment id>: opens the card processor's receipt of one card payment of the
 * booking (follow-up 5), for whoever sees the booking's payments on its page. Square is asked when the link is
 * followed; when it cannot answer, the appointment's page says why. Someone who is not signed in is sent to sign in;
 * anyone else who may not see the payment is answered as for a payment that does not exist.
 */
export async function GET(request: NextRequest, context: RouteContext<"/admin/appointments/[ref]/receipt/[paymentId]">) {
  const { ref, paymentId } = await context.params;
  const page = /^VS-[0-9A-Z]{6}$/.test(ref) ? `/admin/appointments/${ref}` : "/admin";
  const user = await getCurrentUser();
  if (!user) {
    const signIn = new URL("/account/sign-in", request.url);
    signIn.searchParams.set("next", page);
    return Response.redirect(signIn, 303);
  }
  if (!["staff", "manager", "owner"].includes(user.role)) return new Response("Not found", { status: 404 });
  const result = await cardReceiptOf(await getDb(), user, ref, paymentId, resolvePayments().provider, new Date());
  if (result.ok) return Response.redirect(result.url, 303);
  const back = new URL(page, request.url);
  back.searchParams.set("error", result.message);
  back.hash = "payment";
  return Response.redirect(back, 303);
}
