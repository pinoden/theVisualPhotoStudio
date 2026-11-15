-- Rules for the columns added in 0002.

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_credit_valid"
  CHECK ("credit_applied_cents" >= 0 AND "credit_applied_cents" <= "promo_discount_cents");--> statement-breakpoint

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_rescheduled_valid"
  CHECK ("rescheduled_count" >= 0);--> statement-breakpoint

ALTER TABLE "email_outbox"
  ADD CONSTRAINT "email_outbox_attempts_valid"
  CHECK ("attempts" >= 0);--> statement-breakpoint

ALTER TABLE "login_codes"
  ADD CONSTRAINT "login_codes_attempts_valid"
  CHECK ("attempts" >= 0);--> statement-breakpoint

ALTER TABLE "promo_codes"
  ADD CONSTRAINT "promo_codes_generation_valid"
  CHECK ("reschedule_generation" >= 0);--> statement-breakpoint

-- At most one loyalty code per visit and one reschedule credit per booking,
-- so issuing them twice (a retry, two requests at once) cannot create two.
CREATE UNIQUE INDEX "promo_codes_one_per_origin"
  ON "promo_codes" ("origin_booking_id", "source")
  WHERE "origin_booking_id" IS NOT NULL;--> statement-breakpoint

-- Codes are matched without regard to case, so store them in one case.
ALTER TABLE "promo_codes"
  ADD CONSTRAINT "promo_codes_code_uppercase"
  CHECK ("code" = upper("code"));
