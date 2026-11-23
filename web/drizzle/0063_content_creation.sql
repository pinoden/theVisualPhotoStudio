-- Content Creation (the owner's admin brief of 2026-11-22, item 11, and the owner's answer of 2026-11-23: "it's when
-- I'm creating reels/stories for a customer using iPhone, that's similar to a session with a photographer"; question 69
-- in ProjectLibrary.md). A person gives the sessions of one service: the photographer photography's, the content
-- creator content creation's. Every person and session there is now is photography's.
DROP INDEX "photo_packages_studio_duration_idx";--> statement-breakpoint
ALTER TABLE "photo_packages" ADD COLUMN "service" text DEFAULT 'photography' NOT NULL;--> statement-breakpoint
ALTER TABLE "photographers" ADD COLUMN "service" text DEFAULT 'photography' NOT NULL;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD COLUMN "service" text DEFAULT 'photography' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "photo_packages_service_studio_duration_idx" ON "photo_packages" USING btree ("service","studio_id","duration_minutes");--> statement-breakpoint
ALTER TABLE "photo_packages" ADD CONSTRAINT "photo_packages_service" CHECK ("photo_packages"."service" in ('photography', 'content'));--> statement-breakpoint
ALTER TABLE "photographers" ADD CONSTRAINT "photographers_service" CHECK ("photographers"."service" in ('photography', 'content'));--> statement-breakpoint
-- The content creator, working 9 am to 5 pm every day until the owners change it, with no session on sale: nothing of
-- content creation is offered to clients until the owners add one under Admin → Content Creation. After the
-- photographer in order (sort_order 1), so that the site's code before this migration, which books the first person
-- that works, keeps booking the photographer in the minute before its new code is deployed.
INSERT INTO "photographers" ("name", "sort_order", "service")
  SELECT 'In-house content creator', 1, 'content'
  WHERE NOT EXISTS (SELECT 1 FROM "photographers" WHERE "service" = 'content');--> statement-breakpoint
INSERT INTO "photographer_hours" ("photographer_id", "weekday", "open_minute", "close_minute")
  SELECT p."id", d."weekday", 540, 1020
  FROM "photographers" p CROSS JOIN generate_series(1, 7) AS d("weekday")
  WHERE p."service" = 'content'
    AND NOT EXISTS (SELECT 1 FROM "photographer_hours" h WHERE h."photographer_id" = p."id");
