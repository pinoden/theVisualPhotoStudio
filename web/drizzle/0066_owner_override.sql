-- An owner's override (question 79 in ProjectLibrary.md): a booking an owner saves over another's time, having read
-- in a pop-up what it passes over. Its holds are marked, and the no-overlap constraints leave marked holds out; two
-- holds that are not marked still cannot overlap, as before. Every hold there is now stays unmarked.
ALTER TABLE "photographer_holds" ADD COLUMN "overlap_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "studio_holds" ADD COLUMN "overlap_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "studio_holds" DROP CONSTRAINT "studio_holds_no_overlap";--> statement-breakpoint
ALTER TABLE "studio_holds"
  ADD CONSTRAINT "studio_holds_no_overlap"
  EXCLUDE USING gist ("studio_id" WITH =, "occupied" WITH &&) WHERE ("active" AND NOT "overlap_allowed");--> statement-breakpoint
ALTER TABLE "photographer_holds" DROP CONSTRAINT "photographer_holds_no_overlap";--> statement-breakpoint
ALTER TABLE "photographer_holds"
  ADD CONSTRAINT "photographer_holds_no_overlap"
  EXCLUDE USING gist ("photographer_id" WITH =, "occupied" WITH &&) WHERE ("active" AND NOT "overlap_allowed");
