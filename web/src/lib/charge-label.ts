import { durationLabel } from "@/lib/domain/time";

/**
 * What an extra charge is for (follow-up 13): see src/server/charges.ts. `reschedule` is the fee for a move the client
 * asked the studio for after their free ones (the owners' decision of 2026-11-27), which the move itself adds.
 */
export type ChargeKind = "overtime" | "cleaning" | "damage" | "reschedule";

/** How a charge is named: "Overtime, 20 minutes", "Cleaning charge", "Damage charge", "Reschedule fee". */
export function chargeLabel(charge: { kind: ChargeKind; minutes: number | null }): string {
  if (charge.kind === "overtime") return charge.minutes ? `Overtime, ${durationLabel(charge.minutes)}` : "Overtime";
  if (charge.kind === "reschedule") return "Reschedule fee";
  return charge.kind === "cleaning" ? "Cleaning charge" : "Damage charge";
}

/**
 * A charge as the client reads it, on their booking, their receipt and a payment link: a cleaning or damage charge
 * with what it is for ("Damage charge: Broken light stand"), which the owner confirmed the client sees (question 36;
 * the tester's finding of 2026-11-18). Overtime says how long; its note, if any, stays the studio's.
 */
export function clientChargeLabel(charge: { kind: ChargeKind; minutes: number | null; note: string }): string {
  const what = charge.kind === "overtime" || charge.kind === "reschedule" ? "" : charge.note.trim();
  return what ? `${chargeLabel(charge)}: ${what}` : chargeLabel(charge);
}
