import { createHash } from "node:crypto";
import { z } from "zod";
import { formText } from "@/lib/parse";

/**
 * Rules for what clients type, shared by a booking and a membership's checkout, so that both take the same name,
 * email address and phone number. In a module of their own: `bookings.ts` and `memberships.ts` each need the other,
 * and these are used as each loads.
 */

export const emailField = z.string().trim().toLowerCase().max(200).pipe(z.email());
/** Text a person typed: trimmed, line breaks made single, and without the NUL character the database refuses. */
export const textField = (min: number, max: number) => z.string().transform(formText).pipe(z.string().min(min).max(max));
/**
 * Text of one line (a name, a phone number): as `textField`, with a line break or a tab inside made a space. A name
 * goes into the greeting of every email about its booking, where a line break would let whoever typed it begin
 * paragraphs of their own under the studio's name (the preview test of 2026-11-21).
 */
export const lineField = (min: number, max: number) =>
  z
    .string()
    .transform((value) => formText(value).replace(/\s+/g, " "))
    .pipe(z.string().min(min).max(max));

/** What is stored of a secret (a link's token, a page's request id): its SHA-256, never the secret itself. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
