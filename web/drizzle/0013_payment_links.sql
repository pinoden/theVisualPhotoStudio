CREATE TYPE "public"."payment_link_status" AS ENUM('open', 'paid', 'cancelled');--> statement-breakpoint
CREATE TABLE "payment_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_link_id" text NOT NULL,
	"provider_order_id" text NOT NULL,
	"url" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" "payment_link_status" DEFAULT 'open' NOT NULL,
	"created_by" text NOT NULL,
	"payment_id" uuid,
	"paid_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_links_booking_idx" ON "payment_links" USING btree ("booking_id");--> statement-breakpoint
-- One open link for a booking at a time: two people pressing "Email a payment link" at once make one.
CREATE UNIQUE INDEX "payment_links_one_open" ON "payment_links" ("booking_id") WHERE "status" = 'open';--> statement-breakpoint
ALTER TABLE "payment_links"
  ADD CONSTRAINT "payment_links_amount_valid"
  CHECK ("amount_cents" > 0);
