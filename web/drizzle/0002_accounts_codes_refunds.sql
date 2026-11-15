CREATE TYPE "public"."cancel_reason" AS ENUM('customer', 'rescheduled', 'owner');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "credit_applied_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "cancel_reason" "cancel_reason";--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN "reschedule_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN "origin_booking_id" uuid;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN "note" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "status" "refund_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "error" text;