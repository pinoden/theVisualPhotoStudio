ALTER TABLE "bookings" ADD COLUMN "request_key" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "retry_token_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_request_key" ON "bookings" USING btree ("request_key") WHERE "bookings"."request_key" is not null;