-- The owner's answer of 2026-11-23: "the link 'open in maps' should be to the studio's object on Google Maps, not the
-- address". The link the site started with searched for the street address; it becomes the studio's place on Google
-- Maps, in the business details (Website → Header, menu & footer, which every "Open in Maps" reads) and wherever a page
-- names it (the FAQ's answer). Only that address is replaced: the owners' other words, drafts and versions stay.
WITH rewritten AS (
  SELECT id, replace(body, 'https://maps.google.com/?q=7457+Aloma+Ave+Winter+Park+FL', 'https://maps.app.goo.gl/22xMTvm92WbL6RgY6')::jsonb AS content
  FROM site_documents
  CROSS JOIN LATERAL (SELECT jsonb_build_object('draft', draft, 'published', published)::text AS body) AS original
  WHERE deleted_at IS NULL AND body LIKE '%https://maps.google.com/?q=7457+Aloma+Ave+Winter+Park+FL%'
),
changes AS (
  SELECT id, nullif(content->'draft', 'null'::jsonb) AS draft,
    nullif(content->'published', 'null'::jsonb) AS published
  FROM rewritten
),
applied AS (
  UPDATE site_documents AS document
  SET draft = changes.draft,
    draft_revision = document.draft_revision + CASE WHEN changes.draft IS DISTINCT FROM document.draft THEN 1 ELSE 0 END,
    published = changes.published,
    published_by = CASE WHEN changes.published IS DISTINCT FROM document.published THEN 'the site' ELSE document.published_by END,
    published_at = CASE WHEN changes.published IS DISTINCT FROM document.published THEN now() ELSE document.published_at END
  FROM changes
  JOIN site_documents AS original ON original.id = changes.id
  WHERE document.id = changes.id
    AND (changes.published IS DISTINCT FROM original.published OR changes.draft IS DISTINCT FROM original.draft)
  RETURNING document.id, document.published, changes.published IS DISTINCT FROM original.published AS republished
)
INSERT INTO site_versions (document_id, number, content, published_by, note)
SELECT applied.id, coalesce(max(versions.number), 0) + 1, applied.published, 'the site', 'Open in Maps leads to the studio on Google Maps'
FROM applied
LEFT JOIN site_versions AS versions ON versions.document_id = applied.id
WHERE applied.republished
GROUP BY applied.id, applied.published;
