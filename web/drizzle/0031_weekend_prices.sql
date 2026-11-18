-- Replace the old seeded weekend prices with the approved prices.
-- Keep existing custom prices and durations removed in Admin.
UPDATE "price_rules" AS "price"
SET "price_cents" = "approved"."new_cents"
FROM "studios" AS "studio",
  (VALUES
    ('blanche', 60, 8800, 9500),
    ('blanche', 90, 13200, 14250),
    ('blanche', 120, 17600, 19000),
    ('blanche', 180, 26400, 28500),
    ('blanche', 240, 32000, 34500),
    ('blanche', 300, 38500, 41600),
    ('blanche', 480, 60500, 65300),
    ('blanche', 600, 72000, 77700),
    ('dayglow', 60, 7800, 8200),
    ('dayglow', 90, 11700, 12300),
    ('dayglow', 120, 15600, 16400),
    ('dayglow', 180, 23400, 24600),
    ('dayglow', 240, 28500, 30000),
    ('dayglow', 300, 35000, 36800),
    ('dayglow', 480, 54000, 56800),
    ('paris', 60, 6800, 7200),
    ('paris', 90, 10200, 10800),
    ('paris', 120, 13600, 14400),
    ('paris', 180, 19500, 20600),
    ('paris', 240, 24500, 25900),
    ('paris', 300, 30000, 31800)
  ) AS "approved" ("slug", "minutes", "old_cents", "new_cents")
WHERE "price"."studio_id" = "studio"."id"
  AND "studio"."slug" = "approved"."slug"
  AND "price"."day_type" = 'weekend'
  AND "price"."duration_minutes" = "approved"."minutes"
  AND "price"."price_cents" = "approved"."old_cents";
