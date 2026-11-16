CREATE TABLE "site_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"slug" text DEFAULT '' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"draft" jsonb,
	"draft_revision" integer DEFAULT 0 NOT NULL,
	"draft_by" text,
	"draft_at" timestamp with time zone,
	"published" jsonb,
	"published_by" text,
	"published_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"content" jsonb NOT NULL,
	"published_by" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_versions" ADD CONSTRAINT "site_versions_document_id_site_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."site_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_documents_kind_slug" ON "site_documents" USING btree ("kind","slug") WHERE "site_documents"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "site_versions_document_number" ON "site_versions" USING btree ("document_id","number");