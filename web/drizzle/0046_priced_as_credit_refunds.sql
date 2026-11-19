ALTER TABLE "bookings" ADD COLUMN "priced_as" "day_type";--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "credit_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_credit_cents" CHECK ("refunds"."credit_cents" >= 0 and "refunds"."credit_cents" <= "refunds"."amount_cents");--> statement-breakpoint
-- The kind of day each booking made before this was priced as: its day's, by the special dates as they are now and
-- otherwise Saturday and Sunday as weekend (defaultDayType). A move compares the new day with it (follow-up 5).
UPDATE "bookings" SET "priced_as" = coalesce(
  (SELECT "special_dates"."day_type" FROM "special_dates" WHERE "special_dates"."day" = ("bookings"."start_at" AT TIME ZONE 'America/New_York')::date),
  CASE WHEN extract(isodow FROM ("bookings"."start_at" AT TIME ZONE 'America/New_York')) >= 6 THEN 'weekend'::"day_type" ELSE 'weekday'::"day_type" END
) WHERE "priced_as" IS NULL;
