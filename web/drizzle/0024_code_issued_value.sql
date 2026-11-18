ALTER TABLE "promo_codes" ADD COLUMN "issued_cents" integer;--> statement-breakpoint
-- What each code of credit was issued for: what is left on it, plus what stayed spent from it, plus what was refunded
-- off it. A booking that used it keeps what it took while it stands; one that ended without giving it back keeps it
-- too: released for a reschedule code (the money went on into the new code), a booking made with a reschedule code that
-- its client cancelled (nothing comes back), one the studio cancelled after its start, or one whose hold on the time
-- ran out while its payment was unfinished (until this migration's release, only a refused card gave its code back). A
-- refund of a booking released for a reschedule code came off that code. Everything else gave its credit back.
UPDATE "promo_codes" SET "issued_cents" = "value"
  + COALESCE((
    SELECT sum(b."credit_applied_cents") FROM "bookings" b
    WHERE b."promo_code_id" = "promo_codes"."id" AND (
      b."status" IN ('pending_payment', 'confirmed', 'completed', 'no_show')
      OR (b."status" = 'cancelled' AND b."cancel_reason" = 'rescheduled')
      OR (b."status" = 'cancelled' AND b."cancel_reason" = 'customer' AND "promo_codes"."source" = 'reschedule')
      OR (b."status" = 'cancelled' AND b."cancel_reason" = 'owner' AND b."cancelled_at" >= b."start_at")
      OR (b."status" = 'expired' AND NOT EXISTS (
        SELECT 1 FROM "payments" p
        WHERE p."booking_id" = b."id" AND p."status" = 'failed' AND COALESCE(p."error", '') NOT LIKE 'Interrupted before%'
      ))
    )
  ), 0)
  + COALESCE((
    SELECT sum(r."amount_cents") FROM "refunds" r JOIN "payments" p ON p."id" = r."payment_id"
    WHERE "promo_codes"."source" = 'reschedule' AND p."booking_id" = "promo_codes"."origin_booking_id" AND r."created_at" >= "promo_codes"."created_at"
      -- A payment that arrived after the release was given back whole, and never came off the code.
      AND r."reason" NOT LIKE 'Paid after %'
  ), 0)
WHERE "kind" = 'amount';--> statement-breakpoint
UPDATE "promo_codes" SET "issued_cents" = "value" WHERE "kind" <> 'amount';
