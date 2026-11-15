ALTER TABLE "addons" ADD COLUMN "kind" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
-- Say what the add-ons the site started with are for. Add-ons made since are "other" until the owner says.
UPDATE "addons" SET "kind" = 'people' WHERE "slug" IN ('extra-people-1-2', 'extra-people-3-5');--> statement-breakpoint
UPDATE "addons" SET "kind" = 'pet' WHERE "slug" = 'pet-fee';
