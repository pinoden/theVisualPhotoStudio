-- The days a booking with a code may be on (question 80 in ProjectLibrary.md): null, any day, as every code so far.
ALTER TABLE "promo_codes" ADD COLUMN "booking_days" jsonb;
