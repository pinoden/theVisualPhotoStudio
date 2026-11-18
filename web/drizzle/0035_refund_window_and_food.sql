-- The owner's answers of 2026-11-17, for a database that already has values and pages stored.

-- A studio rental is refunded when cancelled 7 days or more ahead (0011 had made it 14 days). Only a value still at
-- that earlier default changes: anything else set by hand is kept. A photography session keeps its own 14 days
-- (photoRefundWindowHours). A database without this row needs nothing here, because the default in
-- src/server/settings.ts changed with this migration.
UPDATE "settings" SET "value" = '168'::jsonb WHERE "key" = 'refundWindowHours' AND "value" = '336'::jsonb;--> statement-breakpoint

-- Food and drinks are not allowed inside the studios (the pages said "not permitted on furniture"). Replace only the
-- original sentence, in the guest information and the policies. Keep all other blocks, drafts and versions.
WITH rewritten AS (
  SELECT id,
    replace(body, 'Food and drinks are not permitted on furniture.', 'Food and drinks are not allowed inside the studios.')::jsonb AS content
  FROM site_documents
  CROSS JOIN LATERAL (SELECT jsonb_build_object('draft', draft, 'published', published)::text AS body) AS original
  WHERE built_in IN ('faq', 'policies')
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
SELECT applied.id, coalesce(max(versions.number), 0) + 1, applied.published, 'the site', 'Food and drinks are not allowed inside the studios'
FROM applied
LEFT JOIN site_versions AS versions ON versions.document_id = applied.id
WHERE applied.republished
GROUP BY applied.id, applied.published;
