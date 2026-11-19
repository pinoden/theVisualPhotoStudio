-- Question 41, answered by the owners on 2026-11-18: "a membership only looks into the time balance, not the price".
-- Members' hours cover weekend time in full, so the switch "At weekends, members pay the difference to the weekend
-- price" goes off where the settings were saved with it on. A database that never saved it reads the new default (off).
-- Bookings already made keep what they were priced at, as every booking keeps its terms.
UPDATE "settings" SET "value" = 'false'::jsonb WHERE "key" = 'memberWeekendDifference';
