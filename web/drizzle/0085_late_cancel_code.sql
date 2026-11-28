-- The owner, 2026-11-28: a cancellation inside the refund window but at least two days before the start gets what was
-- paid as a credit code (settings cancelCodeEnabled and cancelCodeUntilHours, on and 48 in the code, so nothing is
-- stored for them here). Such a code is a kind of its own.
ALTER TYPE "public"."promo_source" ADD VALUE 'cancel';