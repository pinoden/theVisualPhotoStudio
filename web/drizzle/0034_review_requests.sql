ALTER TABLE "bookings" ADD COLUMN "review_requested_at" timestamp with time zone;
--> statement-breakpoint
-- Start with appointments whose review request is still upcoming at rollout.
UPDATE "bookings"
SET "review_requested_at" = now()
WHERE "end_at" < now() - interval '24 hours';
