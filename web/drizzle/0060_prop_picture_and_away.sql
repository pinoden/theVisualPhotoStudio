ALTER TABLE "addons" ADD COLUMN "media_id" uuid;--> statement-breakpoint
ALTER TABLE "addons" ADD COLUMN "away_from" date;--> statement-breakpoint
ALTER TABLE "addons" ADD COLUMN "away_to" date;--> statement-breakpoint
ALTER TABLE "addons" ADD CONSTRAINT "addons_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addons" ADD CONSTRAINT "addons_away" CHECK (("addons"."away_from" is null) = ("addons"."away_to" is null) and ("addons"."away_from" is null or "addons"."away_from" <= "addons"."away_to"));