-- A fourth kind of charge on a booking: the fee for a move the client asked the studio for after their free ones
-- (the owners' decision of 2026-11-27; src/server/charges.ts, `addRescheduleFee`). Until now the studio's move cost
-- the client nothing, and a later move of their own online took the fee off the reschedule code.
ALTER TABLE "booking_charges" DROP CONSTRAINT "booking_charges_kind";--> statement-breakpoint
ALTER TABLE "booking_charges" ADD CONSTRAINT "booking_charges_kind" CHECK ("booking_charges"."kind" in ('overtime', 'cleaning', 'damage', 'reschedule'));
