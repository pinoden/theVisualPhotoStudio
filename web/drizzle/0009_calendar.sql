ALTER TABLE "bookings" ADD COLUMN "made_by" text;--> statement-breakpoint
ALTER TABLE "studios" ADD COLUMN "color" text DEFAULT '#8a7f72' NOT NULL;--> statement-breakpoint
-- A colour of its own for each of the three studios the site started with.
UPDATE "studios" SET "color" = '#4f7cac' WHERE "slug" = 'blanche';--> statement-breakpoint
UPDATE "studios" SET "color" = '#c9851a' WHERE "slug" = 'dayglow';--> statement-breakpoint
UPDATE "studios" SET "color" = '#b4517b' WHERE "slug" = 'paris';
