CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"alt" text DEFAULT '' NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_collection_items" (
	"collection_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "media_collection_items_collection_id_media_id_pk" PRIMARY KEY("collection_id","media_id")
);
--> statement-breakpoint
CREATE TABLE "media_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_files" (
	"key" text PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_font_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"font_id" uuid NOT NULL,
	"file_key" text NOT NULL,
	"format" text NOT NULL,
	"weight" integer DEFAULT 400 NOT NULL,
	"weight_max" integer,
	"italic" boolean DEFAULT false NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_fonts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'display' NOT NULL,
	"licence" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_photos" (
	"studio_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "studio_photos_studio_id_media_id_pk" PRIMARY KEY("studio_id","media_id")
);
--> statement-breakpoint
ALTER TABLE "media_collection_items" ADD CONSTRAINT "media_collection_items_collection_id_media_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."media_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_collection_items" ADD CONSTRAINT "media_collection_items_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_font_files" ADD CONSTRAINT "site_font_files_font_id_site_fonts_id_fk" FOREIGN KEY ("font_id") REFERENCES "public"."site_fonts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_photos" ADD CONSTRAINT "studio_photos_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_photos" ADD CONSTRAINT "studio_photos_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_created_idx" ON "media" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "site_font_files_one_per_style" ON "site_font_files" USING btree ("font_id","weight","italic");