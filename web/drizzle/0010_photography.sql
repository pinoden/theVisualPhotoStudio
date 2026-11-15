CREATE TABLE "photo_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"duration_minutes" integer NOT NULL,
	"price_cents" integer NOT NULL,
	"includes" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photographer_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"photographer_id" uuid NOT NULL,
	"occupied" "tstzrange" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"booking_id" uuid,
	"note" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photographer_hours" (
	"photographer_id" uuid NOT NULL,
	"weekday" integer NOT NULL,
	"open_minute" integer NOT NULL,
	"close_minute" integer NOT NULL,
	CONSTRAINT "photographer_hours_photographer_id_weekday_pk" PRIMARY KEY("photographer_id","weekday")
);
--> statement-breakpoint
CREATE TABLE "photographers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "photographer_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "photo_includes" text;--> statement-breakpoint
ALTER TABLE "photo_packages" ADD CONSTRAINT "photo_packages_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photographer_holds" ADD CONSTRAINT "photographer_holds_photographer_id_photographers_id_fk" FOREIGN KEY ("photographer_id") REFERENCES "public"."photographers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photographer_holds" ADD CONSTRAINT "photographer_holds_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photographer_hours" ADD CONSTRAINT "photographer_hours_photographer_id_photographers_id_fk" FOREIGN KEY ("photographer_id") REFERENCES "public"."photographers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "photo_packages_studio_duration_idx" ON "photo_packages" USING btree ("studio_id","duration_minutes");--> statement-breakpoint
CREATE INDEX "photographer_holds_booking_idx" ON "photographer_holds" USING btree ("booking_id");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_photographer_id_photographers_id_fk" FOREIGN KEY ("photographer_id") REFERENCES "public"."photographers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- The core guarantee for photography: one photographer cannot be taken twice at the same time,
-- whatever the studio. The same kind of constraint that protects the studios.
ALTER TABLE "photographer_holds"
  ADD CONSTRAINT "photographer_holds_no_overlap"
  EXCLUDE USING gist ("photographer_id" WITH =, "occupied" WITH &&) WHERE ("active");--> statement-breakpoint

ALTER TABLE "photographer_holds"
  ADD CONSTRAINT "photographer_holds_range_valid"
  CHECK (NOT isempty("occupied") AND NOT lower_inf("occupied") AND NOT upper_inf("occupied"));--> statement-breakpoint

ALTER TABLE "photographer_hours"
  ADD CONSTRAINT "photographer_hours_valid"
  CHECK ("weekday" BETWEEN 1 AND 7 AND "open_minute" >= 0 AND "close_minute" <= 1440 AND "open_minute" < "close_minute");--> statement-breakpoint

ALTER TABLE "photo_packages"
  ADD CONSTRAINT "photo_packages_valid"
  CHECK ("duration_minutes" > 0 AND "price_cents" >= 0);--> statement-breakpoint

-- The in-house photographer. Until the owner sets their hours, they follow the studios' opening hours:
-- Monday to Friday 9:00 to 19:00, Saturday and Sunday 8:00 to 20:00.
INSERT INTO "photographers" ("name") VALUES ('In-house photographer');--> statement-breakpoint

INSERT INTO "photographer_hours" ("photographer_id", "weekday", "open_minute", "close_minute")
  SELECT p."id", d."weekday",
         CASE WHEN d."weekday" <= 5 THEN 540 ELSE 480 END,
         CASE WHEN d."weekday" <= 5 THEN 1140 ELSE 1200 END
  FROM "photographers" p CROSS JOIN generate_series(1, 7) AS d("weekday");--> statement-breakpoint

-- The photography packages of the studio's live price list (read 2026-11-14), for the studios a
-- database already has. A new database has no studios yet at this point and gets them from the seed.
INSERT INTO "photo_packages" ("studio_id", "duration_minutes", "price_cents", "includes")
  SELECT s."id", v."minutes", v."cents", v."includes"
  FROM "studios" s
  JOIN (VALUES
    ('blanche',  60, 37500, '1–2 outfits, 20 edited images'),
    ('blanche', 120, 57500, '2–3 outfits, 30 edited images'),
    ('blanche', 180, 73000, '3–4 outfits, 40 edited images'),
    ('blanche', 240, 84000, '4–5 outfits, 50 edited images'),
    ('dayglow',  60, 31500, '1–2 outfits, 20 edited images'),
    ('dayglow', 120, 51500, '2–3 outfits, 30 edited images'),
    ('dayglow', 180, 67000, '3–4 outfits, 40 edited images'),
    ('dayglow', 240, 77500, '4–5 outfits, 50 edited images'),
    ('paris',    60, 31500, '1–2 outfits, 20 edited images'),
    ('paris',   120, 51500, '2–3 outfits, 30 edited images'),
    ('paris',   180, 67000, '3–4 outfits, 40 edited images')
  ) AS v("slug", "minutes", "cents", "includes") ON v."slug" = s."slug";
