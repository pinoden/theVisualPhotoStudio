-- The owner's answers of 2026-11-28.
--
-- "Both content creations and photography should have separate sets or requirements": a question, a statement to
-- initial or an agreement is for rentals, for photography sessions, for content creation sessions, or for several of
-- them. Until now "for_photography" stood for sessions of both kinds, so each row starts for content creation
-- exactly where it was for photography: nothing changes for a client until the owners change a row.
ALTER TABLE "agreements" ADD COLUMN "for_content" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "intake_questions" ADD COLUMN "for_content" boolean DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE "agreements" SET "for_content" = "for_photography";--> statement-breakpoint
UPDATE "intake_questions" SET "for_content" = "for_photography";--> statement-breakpoint
-- "Either or, not combine": a discount code is not used on top of a sale's price, unless the owners tick it for
-- that sale. A sale that exists already starts without it, as every new one does.
ALTER TABLE "sales" ADD COLUMN "with_codes" boolean DEFAULT false NOT NULL;
