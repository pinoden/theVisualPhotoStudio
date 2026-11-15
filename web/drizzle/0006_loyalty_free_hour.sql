ALTER TYPE "public"."promo_kind" ADD VALUE 'free_hour';--> statement-breakpoint
-- The first version sent a percent code after every visit. Those codes stay valid, as ordinary codes:
-- left as loyalty codes they would stand in the way of a free hour earned by the same visit
-- (the database allows one code per visit and source).
UPDATE "promo_codes" SET "source" = 'manual' WHERE "source" = 'loyalty' AND "kind" = 'percent';
