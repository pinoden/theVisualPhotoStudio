-- Asked where the old website's /events and /store should lead, the owner answered on 2026-11-28: "Review the docs - I
-- don't know either". On the old website /store is a shop with one product, the free "Studio Guest Guide", and
-- /events is an empty page that its menu does not link to. Guest Information is that guide on this site, so /store
-- leads there, where it still leads to the home page as migration 0074 set it. A destination the owners gave it
-- since is kept, and so is a page they made at /store. The guide's own old address leads there too. /events stays
-- with the contact page. The owners change any of them under Admin → Website → Pages, "Old addresses".
UPDATE "site_redirects" SET "to_path" = '/faq' WHERE "from_path" = '/store' AND "to_path" = '/';--> statement-breakpoint
INSERT INTO "site_redirects" ("from_path", "to_path")
SELECT '/store/p/studio-guest-guide-free-download', '/faq'
WHERE NOT EXISTS (
  SELECT 1 FROM "site_documents" page
  WHERE page."kind" = 'page' AND page."deleted_at" IS NULL AND page."slug" = 'store'
)
ON CONFLICT DO NOTHING;
