ALTER TABLE "booking_answers" ADD COLUMN "initials" text;
--> statement-breakpoint
-- The statements a client initials at the policies step, with one click each (the owner, 2026-11-27): the wording is
-- the draft of the paralegal pass the owner asked for, each statement saying what the Policies page already says.
-- They are rows of Booking Forms & Agreements, of the kind "initials", which the owners change, take off or add to
-- themselves. Figures are live values and follow Settings. Only into a database that has no such statement yet.
INSERT INTO "intake_questions" ("label", "kind", "required", "active", "for_rentals", "for_photography", "sort_order")
SELECT v."label", 'initials', true, true, v."for_rentals", v."for_photography", (SELECT coalesce(max("sort_order"), 0) FROM "intake_questions") + v."place"
FROM (VALUES
  (1, 'I understand that I am renting studio space only: no photographer, photography service or edited images are included, and I may bring my own photographer.', true, false),
  (2, 'I understand that my booked time includes setup and cleanup, that I must leave by the end time, and that overtime fees may apply.', true, false),
  (3, 'I understand that if I cancel less than {refund window} before my start time, my payment is not refunded.', true, false),
  (4, 'I understand that if I cancel less than {photography refund window} before my session, my payment is not refunded.', false, true),
  (5, '{if reschedule fee}I understand that I may reschedule {reschedules allowed} at no charge, that each further reschedule costs {reschedule fee}, and that a rescheduled booking is not refunded.', true, true),
  (6, 'I agree to pay for any damage or excessive cleaning caused by me, my guests, children or pets, as the policies set out.', true, true)
) AS v("place", "label", "for_rentals", "for_photography")
WHERE NOT EXISTS (SELECT 1 FROM "intake_questions" WHERE "kind" = 'initials');
