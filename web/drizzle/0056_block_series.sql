ALTER TABLE "blocks" ADD COLUMN "reason" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "series_id" uuid;--> statement-breakpoint
CREATE INDEX "blocks_series_idx" ON "blocks" USING btree ("series_id");