CREATE TABLE "loyalty_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"kind" text NOT NULL,
	"stamps" integer DEFAULT 0 NOT NULL,
	"code_id" uuid,
	"reason" text NOT NULL,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN "loyalty_seq" integer;--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_code_id_promo_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."promo_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loyalty_ledger_email_idx" ON "loyalty_ledger" USING btree ("email");--> statement-breakpoint
-- Number the free hours already sent, oldest first, for each customer. The kinds are compared as text
-- because every pending migration runs in one transaction, and a value added to an enum earlier in the
-- same transaction (free_hour, in 0006) cannot be used as an enum there yet.
UPDATE "promo_codes" AS p SET "loyalty_seq" = n."seq"
  FROM (
    SELECT "id", row_number() OVER (PARTITION BY "email" ORDER BY "created_at", "id") AS "seq"
    FROM "promo_codes"
    WHERE "source"::text = 'loyalty' AND "kind"::text = 'free_hour' AND "email" IS NOT NULL
  ) AS n
  WHERE n."id" = p."id";--> statement-breakpoint
-- A customer's Nth free hour exists once, however often and from wherever it is sent.
CREATE UNIQUE INDEX "promo_codes_one_per_loyalty_seq"
  ON "promo_codes" ("email", "loyalty_seq")
  WHERE "loyalty_seq" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_ledger"
  ADD CONSTRAINT "loyalty_ledger_valid"
  CHECK (("kind" = 'stamps' AND "stamps" <> 0) OR ("kind" <> 'stamps' AND "stamps" = 0));
