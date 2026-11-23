-- The owner's admin brief of 2026-11-22, item 2: each studio has one colour throughout the admin, Dayglow blue,
-- Paris purple and Blanche green. They replace the colours migration 0009 gave the three studios the site started
-- with, only where a studio still has that colour. Bundles and photography sessions take colours of their own from
-- these (src/lib/domain/appointment-look.ts), and are not stored.
UPDATE "studios" SET "color" = '#2f6fc2' WHERE "slug" = 'dayglow' AND "color" = '#c9851a';--> statement-breakpoint
UPDATE "studios" SET "color" = '#7a4fc2' WHERE "slug" = 'paris' AND "color" = '#b4517b';--> statement-breakpoint
UPDATE "studios" SET "color" = '#3b8f55' WHERE "slug" = 'blanche' AND "color" = '#4f7cac';
