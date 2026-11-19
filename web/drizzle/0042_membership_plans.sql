CREATE TABLE "membership_plan_studios" (
	"plan_id" uuid NOT NULL,
	"studio_id" uuid NOT NULL,
	CONSTRAINT "membership_plan_studios_plan_id_studio_id_pk" PRIMARY KEY("plan_id","studio_id")
);
--> statement-breakpoint
CREATE TABLE "membership_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"minutes" integer NOT NULL,
	"price_cents" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_plans_minutes" CHECK ("membership_plans"."minutes" > 0),
	CONSTRAINT "membership_plans_price" CHECK ("membership_plans"."price_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "membership_plan_studios" ADD CONSTRAINT "membership_plan_studios_plan_id_membership_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."membership_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_plan_studios" ADD CONSTRAINT "membership_plan_studios_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- The memberships of the owners' table (follow-up 3, 2026-11-17), for a database that has the three studios and no
-- plans yet. A new database gets the same plans from the seed (STARTING_PLANS in src/db/seed.ts).
INSERT INTO "membership_plans" ("name", "description", "minutes", "price_cents", "sort_order")
SELECT v.name, v.description, v.minutes, v.price_cents, v.sort_order
FROM (VALUES
  ('Studio Dayglow, 5 hours a month', 'Get creative in Studio Dayglow, the perfect space for vibrant, high-energy shoots.', 300, 33000, 0),
  ('Studio Dayglow, 10 hours a month', 'Enjoy flexible, affordable access to Studio Dayglow, where every session feels vibrant, modern, and full of energy.', 600, 60000, 1),
  ('Studio Paris, 5 hours a month', 'Capture timeless, light-filled moments in Studio Paris, your go-to space for soft, elegant, and modern photography.', 300, 30000, 2),
  ('Studio Paris, 10 hours a month', 'Enjoy the charm and versatility of Studio Paris, a beautifully curated space designed for elegant portraits and creative storytelling.', 600, 55000, 3),
  ('Studio Blanche, 5 hours a month', 'Create freely in Studio Blanche, a bright, modern space perfect for content, portraits, and inspiration.', 300, 38000, 4),
  ('Studio Blanche, 10 hours a month', 'Enjoy consistent, flexible access to Studio Blanche, the perfect space to create whenever inspiration strikes.', 600, 70000, 5),
  ('Paris and Dayglow, 5 hours a month', 'Use your hours in Studio Paris, in Studio Dayglow, or in both booked together.', 300, 52000, 6),
  ('Paris and Dayglow, 10 hours a month', 'Use your hours in Studio Paris, in Studio Dayglow, or in both booked together.', 600, 95000, 7),
  ('Paris and Blanche, 5 hours a month', 'Use your hours in Studio Paris, in Studio Blanche, or in both booked together.', 300, 66000, 8),
  ('Paris and Blanche, 10 hours a month', 'Use your hours in Studio Paris, in Studio Blanche, or in both booked together.', 600, 120000, 9),
  ('All three studios, 5 hours a month', 'Use your hours in any of the three studios, or in several booked together.', 300, 78000, 10),
  ('All three studios, 10 hours a month', 'Use your hours in any of the three studios, or in several booked together.', 600, 145000, 11)
) AS v(name, description, minutes, price_cents, sort_order)
WHERE (SELECT count(*) FROM "studios" WHERE "slug" IN ('blanche', 'dayglow', 'paris')) = 3
  AND NOT EXISTS (SELECT 1 FROM "membership_plans");
--> statement-breakpoint
-- Each of those plans' studios, found by the plan's place in the list. Only plans that have no studios yet: a plan the
-- statement above did not add has its studios already.
INSERT INTO "membership_plan_studios" ("plan_id", "studio_id")
SELECT p.id, s.id
FROM "membership_plans" p
JOIN (VALUES
  (0, 'dayglow'), (1, 'dayglow'), (2, 'paris'), (3, 'paris'), (4, 'blanche'), (5, 'blanche'),
  (6, 'paris'), (6, 'dayglow'), (7, 'paris'), (7, 'dayglow'),
  (8, 'paris'), (8, 'blanche'), (9, 'paris'), (9, 'blanche'),
  (10, 'paris'), (10, 'dayglow'), (10, 'blanche'), (11, 'paris'), (11, 'dayglow'), (11, 'blanche')
) AS v(sort_order, slug) ON v.sort_order = p.sort_order
JOIN "studios" s ON s.slug = v.slug
WHERE NOT EXISTS (SELECT 1 FROM "membership_plan_studios" m WHERE m.plan_id = p.id);
