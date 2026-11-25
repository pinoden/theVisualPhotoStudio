CREATE TABLE "bundle_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_key" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"price_cents" integer NOT NULL,
	CONSTRAINT "bundle_prices_minutes" CHECK ("bundle_prices"."duration_minutes" > 0),
	CONSTRAINT "bundle_prices_price" CHECK ("bundle_prices"."price_cents" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bundle_prices_unique" ON "bundle_prices" USING btree ("studio_key","duration_minutes");--> statement-breakpoint
-- The bundles' prices of the owner's brief of 2026-11-24 (item 4: the studio's Acuity Scheduling prices, before sales
-- tax), the same on every day (the owner, 2026-11-25), for a database that has the three studios and no bundle prices
-- yet. A new database gets the same from the seed (STARTING_BUNDLE_PRICES in src/db/seed.ts). A bundle is named by its
-- studios' ids, sorted as text, joined by "+" (`bundleKey` in src/lib/domain/pricing.ts).
INSERT INTO "bundle_prices" ("studio_key", "duration_minutes", "price_cents")
SELECT b.studio_key, v.minutes, v.price_cents
FROM (VALUES
  ('paris+dayglow', 60, 11500), ('paris+dayglow', 90, 17200), ('paris+dayglow', 120, 23000), ('paris+dayglow', 180, 32000),
  ('paris+dayglow', 240, 40000), ('paris+dayglow', 300, 49000),
  ('blanche+paris', 60, 14000), ('blanche+paris', 90, 19000), ('blanche+paris', 120, 24500), ('blanche+paris', 180, 34000),
  ('blanche+paris', 240, 45500), ('blanche+paris', 300, 55000), ('blanche+paris', 360, 64000), ('blanche+paris', 480, 80000),
  ('all three', 60, 18000), ('all three', 120, 34000), ('all three', 180, 54500), ('all three', 240, 67000),
  ('all three', 300, 80000), ('all three', 600, 150000)
) AS v(bundle, minutes, price_cents)
JOIN (
  SELECT 'paris+dayglow' AS bundle, (SELECT string_agg("id"::text, '+' ORDER BY "id"::text COLLATE "C") FROM "studios" WHERE "slug" IN ('paris', 'dayglow')) AS studio_key
  UNION ALL
  SELECT 'blanche+paris', (SELECT string_agg("id"::text, '+' ORDER BY "id"::text COLLATE "C") FROM "studios" WHERE "slug" IN ('blanche', 'paris'))
  UNION ALL
  SELECT 'all three', (SELECT string_agg("id"::text, '+' ORDER BY "id"::text COLLATE "C") FROM "studios" WHERE "slug" IN ('blanche', 'dayglow', 'paris'))
) AS b ON b.bundle = v.bundle
WHERE (SELECT count(*) FROM "studios" WHERE "slug" IN ('blanche', 'dayglow', 'paris')) = 3
  AND NOT EXISTS (SELECT 1 FROM "bundle_prices");
