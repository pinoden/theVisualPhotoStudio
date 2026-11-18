CREATE TABLE "booking_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"minutes" integer,
	"hourly_cents" integer,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	CONSTRAINT "booking_charges_kind" CHECK ("booking_charges"."kind" in ('overtime', 'cleaning', 'damage')),
	CONSTRAINT "booking_charges_amount" CHECK ("booking_charges"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "booking_charges" ADD CONSTRAINT "booking_charges_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_charges_booking_idx" ON "booking_charges" USING btree ("booking_id");