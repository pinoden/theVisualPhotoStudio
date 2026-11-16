ALTER TABLE "refunds" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
-- Refunds recorded as done before this existed were accepted by the processor and are not asked about again.
UPDATE "refunds" SET "settled_at" = "created_at" WHERE "status" = 'succeeded';
