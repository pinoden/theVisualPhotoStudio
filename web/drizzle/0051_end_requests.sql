CREATE TYPE "public"."end_request" AS ENUM('cancel', 'reschedule');--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "end_request" "end_request";--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "end_requested_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "bookings_end_requested_idx" ON "bookings" USING btree ("end_requested_at") WHERE "bookings"."end_requested_at" is not null;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_end_request" CHECK (("bookings"."end_request" is null) = ("bookings"."end_requested_at" is null));