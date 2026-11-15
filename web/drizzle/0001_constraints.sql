-- Rules the database enforces itself, so no code path can store bad data.

CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

-- The core guarantee: one studio cannot be taken twice at the same time.
ALTER TABLE "studio_holds"
  ADD CONSTRAINT "studio_holds_no_overlap"
  EXCLUDE USING gist ("studio_id" WITH =, "occupied" WITH &&) WHERE ("active");--> statement-breakpoint

ALTER TABLE "studio_holds"
  ADD CONSTRAINT "studio_holds_one_owner"
  CHECK (("booking_id" IS NOT NULL) <> ("block_id" IS NOT NULL));--> statement-breakpoint

ALTER TABLE "studio_holds"
  ADD CONSTRAINT "studio_holds_range_valid"
  CHECK (NOT isempty("occupied") AND NOT lower_inf("occupied") AND NOT upper_inf("occupied"));--> statement-breakpoint

ALTER TABLE "studio_hours"
  ADD CONSTRAINT "studio_hours_valid"
  CHECK ("weekday" BETWEEN 1 AND 7 AND "open_minute" >= 0 AND "close_minute" <= 1440 AND "open_minute" < "close_minute");--> statement-breakpoint

ALTER TABLE "price_rules"
  ADD CONSTRAINT "price_rules_valid"
  CHECK ("duration_minutes" > 0 AND "price_cents" >= 0);--> statement-breakpoint

ALTER TABLE "addons"
  ADD CONSTRAINT "addons_valid"
  CHECK ("price_cents" >= 0 AND "max_quantity" >= 1);--> statement-breakpoint

ALTER TABLE "studios"
  ADD CONSTRAINT "studios_valid"
  CHECK ("buffer_minutes" >= 0 AND "included_guests" >= 1);--> statement-breakpoint

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_valid"
  CHECK (
    "end_at" > "start_at"
    AND "duration_minutes" > 0
    AND "studios_subtotal_cents" >= 0
    AND "multi_studio_discount_cents" >= 0
    AND "addons_cents" >= 0
    AND "promo_discount_cents" >= 0
    AND "total_cents" >= 0
  );--> statement-breakpoint

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_valid"
  CHECK ("amount_cents" > 0 AND "refunded_cents" >= 0 AND "refunded_cents" <= "amount_cents");--> statement-breakpoint

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_valid"
  CHECK ("amount_cents" > 0);--> statement-breakpoint

ALTER TABLE "promo_codes"
  ADD CONSTRAINT "promo_codes_valid"
  CHECK ("value" >= 0 AND "used_count" >= 0 AND "max_uses" >= 1 AND ("kind" <> 'percent' OR "value" <= 100));--> statement-breakpoint

ALTER TABLE "users"
  ADD CONSTRAINT "users_email_lowercase"
  CHECK ("email" = lower("email"));
