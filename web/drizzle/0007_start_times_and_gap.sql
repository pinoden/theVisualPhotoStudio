ALTER TABLE "studios" ALTER COLUMN "buffer_minutes" SET DEFAULT 15;--> statement-breakpoint
-- The owner's rule of 2026-11-15: start times every 15 minutes, and 15 minutes free after each booking
-- (7 minutes before and 7 after each appointment). Only values still at the earlier defaults change:
-- anything the owner set by hand is kept. Bookings already made keep the time that was held for them.
UPDATE "studios" SET "buffer_minutes" = 15 WHERE "buffer_minutes" = 10;--> statement-breakpoint
UPDATE "settings" SET "value" = '15'::jsonb WHERE "key" = 'slotIncrementMinutes' AND "value" = '30'::jsonb;
