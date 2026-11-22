CREATE TABLE "customer_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_email" text NOT NULL,
	"viewer_email" text NOT NULL,
	"viewer_name" text DEFAULT '' NOT NULL,
	"viewer_role" text NOT NULL,
	"what" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"viewed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "customer_views_customer_idx" ON "customer_views" USING btree ("customer_email","viewed_at");--> statement-breakpoint
CREATE INDEX "customer_views_viewed_idx" ON "customer_views" USING btree ("viewed_at");