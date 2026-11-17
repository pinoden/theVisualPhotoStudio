ALTER TABLE "promo_codes" ADD COLUMN "issued_cents" integer;--> statement-breakpoint
-- What each code was issued for. A code of credit is spent down as bookings use it and filled again when one gives it
-- back, so what it was issued for is what is left plus what the bookings that still stand took from it.
UPDATE "promo_codes" SET "issued_cents" = "value" + COALESCE((SELECT sum(b."credit_applied_cents") FROM "bookings" b WHERE b."promo_code_id" = "promo_codes"."id" AND b."status" IN ('pending_payment', 'confirmed', 'completed', 'no_show')), 0) WHERE "kind" = 'amount';--> statement-breakpoint
UPDATE "promo_codes" SET "issued_cents" = "value" WHERE "kind" <> 'amount';
