ALTER TYPE "public"."payment_status" ADD VALUE 'voided';--> statement-breakpoint
ALTER TYPE "public"."promo_source" ADD VALUE 'pet_fee';--> statement-breakpoint
ALTER TABLE "booking_addons" ADD COLUMN "kind" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "method" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "recorded_by" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "note" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Bookings already made: each add-on line takes the kind its add-on has today.
UPDATE "booking_addons" AS line SET "kind" = a."kind" FROM "addons" AS a WHERE a."id" = line."addon_id";--> statement-breakpoint
-- A payment recorded by hand says how the money was taken and who recorded it.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_manual_complete"
  CHECK ("provider" <> 'manual' OR ("method" IS NOT NULL AND "recorded_by" IS NOT NULL));
