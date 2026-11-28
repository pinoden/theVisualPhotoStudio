-- The addresses of the website this one replaces that led nowhere here: twelve of the eighteen in its sitemap (the
-- preview test of 2026-11-21, point 14). The owners approved on 2026-11-27 where each leads, and change any of them
-- under Admin → Website → Pages, "Old addresses".
--
-- An address the owners have already given a destination keeps it (ON CONFLICT DO NOTHING). One that has become a
-- page of this site is left out: a page's own address never leads elsewhere (`addRedirect` in src/server/pages.ts).
-- When the privacy policy gets a page of its own at /privacy-policy, publishing it takes that old address away.
INSERT INTO "site_redirects" ("from_path", "to_path")
SELECT old.from_path, old.to_path
FROM (VALUES
  ('/appointments', '/book'),
  ('/blanche-1', '/studios#blanche'),
  ('/dayglow-1', '/studios#dayglow'),
  ('/paris', '/studios#paris'),
  ('/membership', '/memberships'),
  ('/home-1', '/'),
  ('/christmas-2026-dayglow', '/'),
  ('/christmas-2026-paris', '/'),
  ('/styled-setups', '/studios'),
  ('/events', '/contact'),
  ('/store', '/'),
  ('/privacy-policy', '/policies')
) AS old(from_path, to_path)
WHERE NOT EXISTS (
  SELECT 1 FROM "site_documents" page
  WHERE page."kind" = 'page' AND page."deleted_at" IS NULL AND page."slug" = substr(old.from_path, 2)
)
ON CONFLICT DO NOTHING;
