import type { DbLike } from "@/db/client";
import { acceptedText } from "./booking-forms";
import { acceptedPdf } from "./receipt-pdf";
import { loadBusiness } from "./website";

/**
 * One acceptance of a booking as a PDF file (the owner's admin brief of 2026-11-22, item 8: the agreement "to open or
 * download"), for a route that has made sure the booking is the reader's to see. "Not found" when the acceptance is not
 * that booking's.
 */
export async function acceptedDownload(db: DbLike, booking: { id: string; ref: string; customerName: string }, acceptanceId: string, now: Date): Promise<Response> {
  const text = await acceptedText(db, booking.id, acceptanceId, now);
  if (!text) return new Response("Not found", { status: 404 });
  const file = await acceptedPdf(text, booking, await loadBusiness(db));
  const name = `${text.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "accepted"}-v${text.versionNumber}-${booking.ref}.pdf`;
  return new Response(Buffer.from(file), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${name}"`,
      // A client's booking: never kept by a shared cache.
      "Cache-Control": "private, no-store",
    },
  });
}
