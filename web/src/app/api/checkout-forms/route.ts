import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { isService } from "@/lib/domain/services";
import { isIsoDate } from "@/lib/domain/time";
import { checkoutForms } from "@/server/booking-forms";

/**
 * GET /api/checkout-forms?studios=<id>,<id>&date=YYYY-MM-DD[&service=photography|content]
 * The intake questions and the agreements beside the studio policies that a booking of these studios, of this type,
 * on this day, meets at checkout (src/server/booking-forms.ts): the published ones only. Read live; never cached.
 * Without a service, a studio rental. `photography=1`, as a page loaded before 2026-11-28 still asks, is a
 * photography session.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const date = params.get("date") ?? "";
  const studioIds = (params.get("studios") ?? "").split(",").filter(Boolean).slice(0, 10);
  if (!isIsoDate(date) || studioIds.length === 0) return Response.json({ ok: false, message: "Choose studios and a date." }, { status: 400 });
  const named = params.get("service");
  const service = isService(named) ? named : params.get("photography") === "1" ? "photography" : null;
  const forms = await checkoutForms(await getDb(), { studioIds, date, service });
  return Response.json(
    {
      ok: true,
      questions: forms.questions.map(({ id, label, help, kind, options, required }) => ({ id, label, help, kind, options, required })),
      agreements: forms.agreements.map(({ versionId, number, title, body }) => ({ versionId, number, title, body })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
