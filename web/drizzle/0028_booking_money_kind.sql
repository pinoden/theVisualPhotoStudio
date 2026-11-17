-- Each booking says which kind of money it is (src/server/test-mode.ts), in place of the database as a whole
-- (0027), which a server in test mode still running beside the live account could contradict.
DROP TABLE "money_kind" CASCADE;--> statement-breakpoint
-- Until 2026-11-17 09:27 (New York), when Square's sandbox got a name of its own, the site recorded the sandbox's
-- payments and links as "square". Square's live account had never been used: every one of them is the sandbox's.
UPDATE "payments" SET "provider" = 'square-sandbox' WHERE "provider" = 'square' AND "created_at" < '2026-11-17T14:27:05Z';--> statement-breakpoint
UPDATE "payment_links" SET "provider" = 'square-sandbox' WHERE "provider" = 'square' AND "created_at" < '2026-11-17T14:27:05Z';--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "money_kind" text;--> statement-breakpoint
-- Every booking made before this ran in test mode, unless the live account took money for it.
UPDATE "bookings" SET "money_kind" = CASE
  WHEN EXISTS (SELECT 1 FROM "payments" WHERE "payments"."booking_id" = "bookings"."id" AND "payments"."provider" = 'square')
    OR EXISTS (SELECT 1 FROM "payment_links" WHERE "payment_links"."booking_id" = "bookings"."id" AND "payment_links"."provider" = 'square')
  THEN 'live' ELSE 'test' END;--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "money_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_money_kind" CHECK ("bookings"."money_kind" in ('test', 'live'));
