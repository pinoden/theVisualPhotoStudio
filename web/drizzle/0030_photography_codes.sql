ALTER TABLE "promo_codes" ADD COLUMN "photography_only" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- A client who already released a session must still be able to rebook it.
UPDATE "promo_codes"
SET "photography_only" = true
FROM "bookings"
WHERE "promo_codes"."source" = 'reschedule'
  AND "promo_codes"."origin_booking_id" = "bookings"."id"
  AND "bookings"."photographer_id" IS NOT NULL;
