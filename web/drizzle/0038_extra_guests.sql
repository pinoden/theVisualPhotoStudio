ALTER TABLE "studios" ADD COLUMN "extra_guests" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Follow-up 2, the owner's answer of 2026-11-17: Blanche and Dayglow take 6 guests beyond those included, Paris 4.
UPDATE "studios" SET "extra_guests" = 6 WHERE "slug" IN ('blanche', 'dayglow');--> statement-breakpoint
UPDATE "studios" SET "extra_guests" = 4 WHERE "slug" = 'paris';--> statement-breakpoint
-- One add-on, $5 for each extra guest, taken in a quantity, in place of the two extra-people tiers. The tiers stay
-- in the table, switched off: bookings made with them keep their own name and price (booking_addons).
UPDATE "addons" SET "active" = false WHERE "slug" IN ('extra-people-1-2', 'extra-people-3-5');--> statement-breakpoint
-- Only in a database that has its catalog: a new one gets the add-on from the starting catalog (src/db/seed.ts).
INSERT INTO "addons" ("slug", "name", "description", "price_cents", "studio_id", "max_quantity", "kind", "sort_order", "active")
SELECT 'extra-guest', 'Extra guest', 'For each guest beyond those included with the studio.', 500, NULL, 20, 'people', 0, true
WHERE EXISTS (SELECT 1 FROM "studios") AND NOT EXISTS (SELECT 1 FROM "addons" WHERE "slug" = 'extra-guest');
