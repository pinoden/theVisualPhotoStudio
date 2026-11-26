ALTER TABLE "bookings" ADD COLUMN "tax_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "tax_basis_points" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "tax_studio" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "tax_addons" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tax" CHECK ("bookings"."tax_cents" >= 0 and "bookings"."tax_basis_points" >= 0 and "bookings"."tax_basis_points" <= 2000);