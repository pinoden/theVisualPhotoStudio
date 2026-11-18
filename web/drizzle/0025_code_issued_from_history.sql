-- What a reschedule code was issued for is what its booking's history says it was released for ("Released for a
-- reschedule code worth $126"). Migration 0024 worked it out from what became of the bookings and refunds, and took a
-- refund that had failed before the release, and went through after it, for one that came off the code. A code issued
-- since keeps its figure itself, and the history says the same, so this changes nothing for it, whichever version of
-- 0024 a database ran. A code whose history has no such line keeps what 0024 worked out.
UPDATE "promo_codes" SET "issued_cents" = "released"."cents"
FROM (
  SELECT DISTINCT ON (e."booking_id")
    e."booking_id",
    round(replace(substring(e."note" from '^Released for a reschedule code worth \$([0-9,]+(?:\.[0-9]{2})?)$'), ',', '')::numeric * 100)::integer AS "cents"
  FROM "booking_events" e
  WHERE e."note" LIKE 'Released for a reschedule code worth $%'
  ORDER BY e."booking_id", e."at" DESC
) AS "released"
WHERE "promo_codes"."source" = 'reschedule'
  AND "promo_codes"."kind" = 'amount'
  AND "promo_codes"."origin_booking_id" = "released"."booking_id"
  AND "released"."cents" IS NOT NULL;
