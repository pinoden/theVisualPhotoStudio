import { NextResponse, type NextRequest } from "next/server";
import { isCheckScope, WEBSITE_CHECK_HEADER, WEBSITE_CHECK_PARAM } from "@/lib/site/website-check";

/**
 * Runs only for an address with `?website-check=`, which the website editor's
 * phone check loads (src/lib/site/website-check.ts): it hands the query on as
 * a request header, which the root layout can read and a query is not. The
 * header only narrows what a preview shows to its editor; it shows nothing
 * to anyone else.
 */
export function proxy(request: NextRequest) {
  const scope = request.nextUrl.searchParams.get(WEBSITE_CHECK_PARAM);
  const headers = new Headers(request.headers);
  if (isCheckScope(scope)) headers.set(WEBSITE_CHECK_HEADER, scope);
  else headers.delete(WEBSITE_CHECK_HEADER);
  return NextResponse.next({ request: { headers } });
}

// Next.js reads this without running the module, so it holds the parameter's name itself: WEBSITE_CHECK_PARAM.
export const config = {
  matcher: [{ source: "/:path*", has: [{ type: "query", key: "website-check" }] }],
};
