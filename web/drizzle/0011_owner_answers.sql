-- The owner's answers of 2026-11-15, for a database that already has values stored. Only values still at
-- the earlier defaults change: anything set by hand since is kept. A database without these rows needs
-- nothing here, because the defaults in src/server/settings.ts changed with this migration.

-- Cancellations: refunded when cancelled 14 days or more ahead (it was 7 days).
UPDATE "settings" SET "value" = '336'::jsonb WHERE "key" = 'refundWindowHours' AND "value" = '168'::jsonb;--> statement-breakpoint
-- A free hour is valid for 90 days (it was 60). Free hours already sent keep the date their email gave.
UPDATE "settings" SET "value" = '90'::jsonb WHERE "key" = 'loyaltyValidDays' AND "value" = '60'::jsonb;--> statement-breakpoint
-- Staff see customers' phone numbers and emails. The switch on the Staff page stays, so the owners can
-- turn it off again; a stored "off" dates from before the answer, when off was the default.
UPDATE "settings" SET "value" = 'true'::jsonb WHERE "key" = 'staffSeesContact' AND "value" = 'false'::jsonb;--> statement-breakpoint
-- The photographer works 9 am to 5 pm, so the last one-hour session starts at 4 pm. Only hours still as
-- the photography migration set them (the studios' opening hours) change.
UPDATE "photographer_hours" SET "open_minute" = 540, "close_minute" = 1020
  WHERE ("weekday" <= 5 AND "open_minute" = 540 AND "close_minute" = 1140)
     OR ("weekday" >= 6 AND "open_minute" = 480 AND "close_minute" = 1200);
