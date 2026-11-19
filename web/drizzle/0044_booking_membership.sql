ALTER TABLE "bookings" ADD COLUMN "membership_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "membership_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "membership_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE restrict ON UPDATE no action;