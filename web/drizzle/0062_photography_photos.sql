-- The owners' note 4 of 2026-11-22 and the owner's answer of 2026-11-23 ("let admin a chance to decide"): the photos
-- the site shows for photography, chosen and ordered under Admin → Photography (question 73 in ProjectLibrary.md).
-- A new, empty table: nothing that is there changes.
CREATE TABLE "photography_photos" (
	"media_id" uuid PRIMARY KEY NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "photography_photos" ADD CONSTRAINT "photography_photos_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE restrict ON UPDATE no action;