CREATE TABLE "site_redirects" (
	"from_path" text PRIMARY KEY NOT NULL,
	"to_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The addresses of the website this one replaces that are known to differ (see "Live reference" in CLAUDE.md):
-- its guest information, photography and rates pages. A visitor or a search engine that still has one is sent on.
INSERT INTO "site_redirects" ("from_path", "to_path") VALUES
  ('/guestinfo', '/faq'),
  ('/services-2-1', '/services'),
  ('/rates-1', '/rates')
ON CONFLICT DO NOTHING;
