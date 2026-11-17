CREATE TABLE "money_kind" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"kind" text NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "money_kind_one_row" CHECK ("money_kind"."id" = 1),
	CONSTRAINT "money_kind_kind" CHECK ("money_kind"."kind" in ('test', 'live'))
);
--> statement-breakpoint
-- Every database made before this one ran in test mode: Square's live account had never been used. One that holds
-- anything of bookings is marked so, its bookings made in the admin and payments recorded by hand included; one that
-- took a payment through the live account would be marked live. A database with no booking is left unmarked: the
-- card processor that opens it next decides (src/server/test-mode.ts).
INSERT INTO "money_kind" ("id", "kind")
SELECT 1, CASE WHEN EXISTS (SELECT 1 FROM "payments" WHERE "provider" = 'square') THEN 'live' ELSE 'test' END
WHERE EXISTS (SELECT 1 FROM "bookings") OR EXISTS (SELECT 1 FROM "payments") OR EXISTS (SELECT 1 FROM "payment_links");
