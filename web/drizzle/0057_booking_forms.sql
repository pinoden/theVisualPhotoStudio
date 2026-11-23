CREATE TABLE "agreement_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"published_by" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agreements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"draft" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"studio_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"for_rentals" boolean DEFAULT true NOT NULL,
	"for_photography" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"site_version_id" uuid,
	"agreement_version_id" uuid,
	"version_number" integer NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"question_id" uuid,
	"label" text NOT NULL,
	"answer" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"help" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"studio_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"for_rentals" boolean DEFAULT true NOT NULL,
	"for_photography" boolean DEFAULT true NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agreement_versions" ADD CONSTRAINT "agreement_versions_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_acceptances" ADD CONSTRAINT "booking_acceptances_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_acceptances" ADD CONSTRAINT "booking_acceptances_site_version_id_site_versions_id_fk" FOREIGN KEY ("site_version_id") REFERENCES "public"."site_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_acceptances" ADD CONSTRAINT "booking_acceptances_agreement_version_id_agreement_versions_id_fk" FOREIGN KEY ("agreement_version_id") REFERENCES "public"."agreement_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_answers" ADD CONSTRAINT "booking_answers_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_answers" ADD CONSTRAINT "booking_answers_question_id_intake_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."intake_questions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agreement_versions_number" ON "agreement_versions" USING btree ("agreement_id","number");--> statement-breakpoint
CREATE INDEX "booking_acceptances_booking_idx" ON "booking_acceptances" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "booking_answers_booking_idx" ON "booking_answers" USING btree ("booking_id");