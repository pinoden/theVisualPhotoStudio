CREATE TABLE "membership_minutes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"membership_id" uuid NOT NULL,
	"minutes" integer NOT NULL,
	"kind" text NOT NULL,
	"payment_id" uuid,
	"booking_id" uuid,
	"note" text DEFAULT '' NOT NULL,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_minutes_payment_id_unique" UNIQUE("payment_id"),
	CONSTRAINT "membership_minutes_kind" CHECK ("membership_minutes"."kind" in ('month', 'booking', 'returned', 'correction')),
	CONSTRAINT "membership_minutes_not_zero" CHECK ("membership_minutes"."minutes" <> 0)
);
--> statement-breakpoint
CREATE TABLE "membership_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"membership_id" uuid NOT NULL,
	"processor_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"period_start" date NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"refunded_at" timestamp with time zone,
	CONSTRAINT "membership_payments_processor_id_unique" UNIQUE("processor_id"),
	CONSTRAINT "membership_payments_amount" CHECK ("membership_payments"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "membership_plan_prices" (
	"plan_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"price_cents" integer NOT NULL,
	"processor_plan_id" text NOT NULL,
	"variation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_plan_prices_plan_id_provider_price_cents_pk" PRIMARY KEY("plan_id","provider","price_cents")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"plan_id" uuid NOT NULL,
	"plan_name" text NOT NULL,
	"minutes_per_month" integer NOT NULL,
	"price_cents" integer NOT NULL,
	"code" text NOT NULL,
	"status" text NOT NULL,
	"request_key" text NOT NULL,
	"provider" text NOT NULL,
	"customer_id" text,
	"card_id" text,
	"subscription_id" text,
	"started_on" date NOT NULL,
	"paid_through" date,
	"cancelled_at" timestamp with time zone,
	"ends_on" date,
	"problem" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_code_unique" UNIQUE("code"),
	CONSTRAINT "memberships_request_key_unique" UNIQUE("request_key"),
	CONSTRAINT "memberships_status" CHECK ("memberships"."status" in ('starting', 'active', 'cancelled', 'stopped', 'failed')),
	CONSTRAINT "memberships_minutes" CHECK ("memberships"."minutes_per_month" > 0),
	CONSTRAINT "memberships_price" CHECK ("memberships"."price_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "membership_minutes" ADD CONSTRAINT "membership_minutes_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_minutes" ADD CONSTRAINT "membership_minutes_payment_id_membership_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."membership_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_minutes" ADD CONSTRAINT "membership_minutes_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_payments" ADD CONSTRAINT "membership_payments_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_plan_prices" ADD CONSTRAINT "membership_plan_prices_plan_id_membership_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."membership_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_plan_id_membership_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."membership_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "membership_minutes_membership_idx" ON "membership_minutes" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "memberships_email_idx" ON "memberships" USING btree ("email");--> statement-breakpoint
-- The live site's memberships page, read 2026-11-14, leads to the new one. One the owners have set already stays.
INSERT INTO "site_redirects" ("from_path", "to_path") VALUES ('/studio-memberships', '/memberships') ON CONFLICT DO NOTHING;
