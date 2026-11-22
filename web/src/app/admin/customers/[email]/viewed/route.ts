import { getDb } from "@/db/client";
import { can } from "@/lib/abilities";
import { recordCustomerView } from "@/server/customer-views";
import { getCurrentUser } from "@/server/session";
import { loadSettings } from "@/server/settings";

/**
 * POST /admin/customers/<email>/viewed: the access log's line for a customer's page (question 27), sent by the page
 * once it is on screen (`RecordView`). Only from the site's own pages: a browser says where a request comes from
 * (`Sec-Fetch-Site`), and the sign-in cookie is not sent with another site's post anyway (SameSite Lax). Writes only for
 * someone who may see customers, and answers nothing either way.
 */
export async function POST(request: Request, context: RouteContext<"/admin/customers/[email]/viewed">) {
  const from = request.headers.get("sec-fetch-site");
  if (from !== null && from !== "same-origin") return new Response(null, { status: 403 });
  const user = await getCurrentUser();
  if (user) {
    const db = await getDb();
    if (can(user, "seeCustomers", await loadSettings(db))) {
      const { email } = await context.params;
      await recordCustomerView(db, user, decodeURIComponent(email), "page", "", new Date());
    }
  }
  return new Response(null, { status: 204 });
}
