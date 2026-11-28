CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"percent" integer NOT NULL,
	"studio_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"book_from" date NOT NULL,
	"book_until" date NOT NULL,
	"visit_from" date,
	"visit_until" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_percent" CHECK ("sales"."percent" between 1 and 90),
	CONSTRAINT "sales_days" CHECK ("sales"."book_until" >= "sales"."book_from")
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "sale" jsonb;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "sale_cents" integer DEFAULT 0 NOT NULL;