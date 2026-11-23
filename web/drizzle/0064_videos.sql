-- Video files the owners upload (the owners' note 7 of 2026-11-22; "Set up neon", 2026-11-23; question 77 in
-- ProjectLibrary.md): a new, empty table. The files are in Neon's object storage on the host.
CREATE TABLE "videos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "videos_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "videos_status" CHECK ("videos"."status" in ('uploading', 'ready')),
	CONSTRAINT "videos_size" CHECK ("videos"."size" > 0)
);
