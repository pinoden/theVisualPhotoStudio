CREATE TABLE "waitlist_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_ids" jsonb NOT NULL,
	"photography" boolean DEFAULT false NOT NULL,
	"duration_minutes" integer NOT NULL,
	"day" date NOT NULL,
	"from_minute" integer NOT NULL,
	"to_minute" integer NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"removed_by" text
);
--> statement-breakpoint
CREATE INDEX "waitlist_entries_day_idx" ON "waitlist_entries" USING btree ("day");--> statement-breakpoint
CREATE INDEX "waitlist_entries_email_idx" ON "waitlist_entries" USING btree ("email");