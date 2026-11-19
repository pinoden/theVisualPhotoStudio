CREATE TABLE "email_templates" (
	"key" text PRIMARY KEY NOT NULL,
	"subject" text,
	"body" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "email_templates_wording" CHECK (("email_templates"."subject" is null) = ("email_templates"."body" is null))
);
